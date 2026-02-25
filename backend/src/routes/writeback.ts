import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { applyAutoWriteback, recordWritebackAudit } from '../services/orchestrator';
import { syncProfileToolSchema } from '../agents/sync-profile-tool';

export const writebackRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

writebackRoutes.use('*', authMiddleware);

const writebackPayloadSchema = syncProfileToolSchema.omit({ summary_text: true });

const commitSchema = z.object({
  draft_id: z.string().min(8).max(128),
  payload: writebackPayloadSchema.optional().nullable(),
  context_text: z.string().max(20_000).optional().nullable(),
});

type CommitRow = {
  user_id: string;
  status: string;
  summary_json: string | null;
  error: string | null;
};

function toErrMsg(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '同步失败';
}

// POST /api/writeback/commit
// Local-First：移动端持久化草稿后，通过该幂等接口把草稿应用到远端 D1
writebackRoutes.post('/commit', async (c) => {
  const userId = c.get('userId');

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  const parsed = commitSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ success: false, error: '参数错误' }, 400);
  }

  const draftId = parsed.data.draft_id;
  const payload = parsed.data.payload ?? {};
  const contextText = typeof parsed.data.context_text === 'string' ? parsed.data.context_text : '';

  const existing = await c.env.DB.prepare(
    'SELECT user_id, status, summary_json, error FROM writeback_commits WHERE draft_id = ?'
  )
    .bind(draftId)
    .first<CommitRow>();

  if (existing) {
    if (existing.user_id !== userId) {
      return c.json({ success: false, error: 'draft_id 不属于当前用户' }, 403);
    }
    if (existing.status === 'success') {
      let summary: unknown = null;
      if (existing.summary_json) {
        try { summary = JSON.parse(existing.summary_json); } catch { /* ignore */ }
      }
      return c.json({
        success: true,
        data: { draft_id: draftId, status: 'success', summary, committed: true },
      });
    }
    if (existing.status === 'pending') {
      return c.json({ success: true, data: { draft_id: draftId, status: 'pending' } }, 202);
    }
    return c.json({ success: false, error: existing.error || '上次同步失败' }, 409);
  }

  // 先写入 pending 记录作为幂等锁，防止重试/并发导致重复写入
  const payloadJson = JSON.stringify(payload ?? {});
  try {
    await c.env.DB.prepare(
      `INSERT INTO writeback_commits (draft_id, user_id, status, payload_json, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, datetime('now'), datetime('now'))`
    )
      .bind(draftId, userId, payloadJson)
      .run();
  } catch (error) {
    // 可能是并发插入导致的冲突，回读一次并按既有状态返回
    const raced = await c.env.DB.prepare(
      'SELECT user_id, status, summary_json, error FROM writeback_commits WHERE draft_id = ?'
    )
      .bind(draftId)
      .first<CommitRow>();
    if (raced && raced.user_id === userId && raced.status === 'success') {
      let summary: unknown = null;
      if (raced.summary_json) {
        try { summary = JSON.parse(raced.summary_json); } catch { /* ignore */ }
      }
      return c.json({ success: true, data: { draft_id: draftId, status: 'success', summary, committed: true } });
    }
    return c.json({ success: true, data: { draft_id: draftId, status: 'pending' } }, 202);
  }

  try {
    const summary = await applyAutoWriteback(c.env.DB, userId, payload, { contextText });
    const summaryJson = JSON.stringify(summary);

    await c.env.DB.prepare(
      `UPDATE writeback_commits
       SET status = 'success', summary_json = ?, error = NULL, updated_at = datetime('now')
       WHERE draft_id = ? AND user_id = ?`
    )
      .bind(summaryJson, draftId, userId)
      .run();

    try {
      await recordWritebackAudit(c.env.DB, userId, 'writeback_commit', summary, null, contextText || '[commit]');
    } catch { /* ignore */ }

    return c.json({ success: true, data: { draft_id: draftId, status: 'success', summary } });
  } catch (error) {
    const errMsg = toErrMsg(error);
    try {
      await c.env.DB.prepare(
        `UPDATE writeback_commits
         SET status = 'failed', error = ?, updated_at = datetime('now')
         WHERE draft_id = ? AND user_id = ?`
      )
        .bind(errMsg, draftId, userId)
        .run();
    } catch { /* ignore */ }

    try {
      await recordWritebackAudit(c.env.DB, userId, 'writeback_commit', null, errMsg, contextText || '[commit]');
    } catch { /* ignore */ }

    return c.json({ success: false, error: errMsg }, 500);
  }
});

