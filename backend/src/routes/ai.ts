import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { callLLM, parseSSEContent } from '../services/llm';
import { buildContextForRole, getChatHistory, getUserContext, trimMessages } from '../services/context';
import {
  runAutoOrchestrate,
  decideRoute,
  SYSTEM_PROMPTS as ORCHESTRATOR_SYSTEM_PROMPTS,
  ROLE_NAMES,
  MAX_HISTORY_MESSAGES,
  resolveWritebackPayload,
  applyAutoWriteback,
  saveOrchestrateHistory,
  recordWritebackAudit,
  hasWritebackChanges,
  generateCollaboratorSupplements,
} from '../services/orchestrator';
import type { OrchestrateHistoryMessage } from '../services/orchestrator';
import { SSEStreamWriter } from '../services/stream-writer';
import { streamPrimaryAgent } from '../services/agent-runner';
import { DOCTOR_SYSTEM_PROMPT } from '../prompts/doctor';
import { REHAB_SYSTEM_PROMPT } from '../prompts/rehab';
import { NUTRITIONIST_SYSTEM_PROMPT } from '../prompts/nutritionist';
import { TRAINER_SYSTEM_PROMPT } from '../prompts/trainer';
import { isEnumValue, isNonEmptyString, isPlainObject } from '../utils/validate';
import type { AIRole, SSERoutingEvent } from '../../../shared/types';

const SYSTEM_PROMPTS: Record<AIRole, string> = {
  doctor: DOCTOR_SYSTEM_PROMPT,
  rehab: REHAB_SYSTEM_PROMPT,
  nutritionist: NUTRITIONIST_SYSTEM_PROMPT,
  trainer: TRAINER_SYSTEM_PROMPT,
};

const VALID_ROLES: AIRole[] = ['doctor', 'rehab', 'nutritionist', 'trainer'];
const MESSAGE_MAX_LENGTH = 5000;
const ORCHESTRATOR_ROLE = 'orchestrator';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, Math.min(i + 8192, bytes.length));
    chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  return btoa(chunks.join(''));
}

const aiChatRateLimit = createRateLimit({
  key: 'ai-chat',
  limit: 20,
  windowSeconds: 60,
  target: 'user',
  message: 'AI 请求过于频繁，请稍后重试',
});

const aiOrchestrateRateLimit = createRateLimit({
  key: 'ai-orchestrate',
  limit: 12,
  windowSeconds: 60,
  target: 'user',
  message: '智能会诊请求过于频繁，请稍后重试',
});

export const aiRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

aiRoutes.use('*', authMiddleware);

/**
 * @deprecated 仅用于特定工具调用（首页训练计划生成、饮食图片分析、通用图片分析）。
 * 通用聊天请使用 POST /api/ai/orchestrate/stream。
 */
// POST /api/ai/chat
aiRoutes.post('/chat', aiChatRateLimit, async (c) => {
  const userId = c.get('userId');
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(payload)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const role = payload.role;
  const message = payload.message;

  if (!isEnumValue(role, VALID_ROLES)) {
    return c.json({ success: false, error: '无效的 AI 角色' }, 400);
  }
  if (!isNonEmptyString(message)) {
    return c.json({ success: false, error: '消息不能为空' }, 400);
  }
  if (message.length > MESSAGE_MAX_LENGTH) {
    return c.json({ success: false, error: `消息长度不能超过 ${MESSAGE_MAX_LENGTH} 字符` }, 400);
  }
  const trimmedMessage = message.trim();

  // Handle image: inline base64 (small) OR R2 key from prior upload (large)
  let imageUrl: string | null = null;
  let imageDataUri: string | null = null;
  const inlineImage = payload.image;
  const imageKey = payload.image_key;

  if (typeof inlineImage === 'string' && inlineImage.startsWith('data:image/')) {
    // Strategy 1: Small image sent inline as base64
    imageDataUri = inlineImage;
    try {
      const match = inlineImage.match(/^data:image\/([\w+]+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const raw = match[2];
        const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
        const key = `chat-images/${userId}/${crypto.randomUUID()}.${ext}`;
        await c.env.R2.put(key, bytes, { httpMetadata: { contentType: `image/${match[1]}` } });
        imageUrl = key;
      }
    } catch {
      // R2 save failed, image still sent to LLM via imageDataUri
    }
  } else if (typeof imageKey === 'string' && imageKey.startsWith(`chat-images/${userId}/`)) {
    // Strategy 2: Large image already uploaded, read from R2
    try {
      const object = await c.env.R2.get(imageKey);
      if (object) {
        const arrayBuffer = await object.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        const mimeType = object.httpMetadata?.contentType || 'image/jpeg';
        imageDataUri = `data:${mimeType};base64,${base64}`;
        imageUrl = imageKey;
      }
    } catch {
      // Image read failed, continue without image
    }
  }

  // Fetch user context and chat history in parallel
  const [userContext, chatHistory] = await Promise.all([
    getUserContext(c.env.DB, userId),
    getChatHistory(c.env.DB, userId, role),
  ]);

  // Build system prompt with user context
  const contextStr = buildContextForRole(role, userContext);
  const systemPrompt = SYSTEM_PROMPTS[role] + '\n\n' + contextStr;

  // Build the current user message (multimodal if image present)
  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };
  const currentUserContent: string | ContentPart[] = imageDataUri
    ? [
        { type: 'image_url' as const, image_url: { url: imageDataUri } },
        { type: 'text' as const, text: trimmedMessage },
      ]
    : trimmedMessage;

  // Build messages array
  const messages = trimMessages(
    [
      { role: 'system' as const, content: systemPrompt },
      ...chatHistory.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user' as const, content: currentUserContent },
    ],
    {
      maxSystemTokens: 8000,
      maxHistoryTokens: 4000,
      totalTokens: 12000,
    }
  );

  // Save user message
  const userMsgId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO chat_history (id, user_id, role, message_role, content, image_url) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(userMsgId, userId, role, 'user', trimmedMessage, imageUrl)
    .run();

  // Call LLM with streaming
  try {
    const llmResponse = await callLLM({ env: c.env, messages, stream: true });
    if (!llmResponse.body) {
      return c.json({ success: false, error: 'LLM 返回了空响应流' }, 502);
    }

    // Create a TransformStream to intercept and save the full response
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    let fullContent = '';
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const writer = writable.getWriter();
    const reader = llmResponse.body.getReader();

    // Process stream in background
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          // Parse SSE chunks for content
          const text = decoder.decode(value, { stream: true });
          fullContent += parseSSEContent(text);

          await writer.write(value);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : '流式响应中断';
        const sseError = `event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`;
        await writer.write(encoder.encode(sseError));
      } finally {
        // Save assistant response to DB
        try {
          if (fullContent.trim().length > 0) {
            const assistantMsgId = crypto.randomUUID();
            await c.env.DB.prepare(
              'INSERT INTO chat_history (id, user_id, role, message_role, content) VALUES (?, ?, ?, ?, ?)'
            )
              .bind(assistantMsgId, userId, role, 'assistant', fullContent)
              .run();
          }
        } catch (error) {
          const logKey = `log:ai-save-error:${Date.now()}:${crypto.randomUUID()}`;
          const logPayload = {
            userId,
            role,
            error: error instanceof Error ? error.message : '保存 AI 消息失败',
            at: new Date().toISOString(),
          };
          await c.env.KV.put(logKey, JSON.stringify(logPayload), { expirationTtl: 60 * 60 * 24 * 7 });
        }

        try {
          await writer.close();
        } catch {
          // ignore
        }
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'LLM 调用失败';
    const statusCode = errMsg.includes('超时') ? 504 : 502;
    return c.json({ success: false, error: errMsg }, statusCode);
  }
});

// POST /api/ai/orchestrate
aiRoutes.post('/orchestrate', aiOrchestrateRateLimit, async (c) => {
  const userId = c.get('userId');
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(payload)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const message = payload.message;
  if (!isNonEmptyString(message)) {
    return c.json({ success: false, error: '消息不能为空' }, 400);
  }
  if (message.length > MESSAGE_MAX_LENGTH) {
    return c.json({ success: false, error: `消息长度不能超过 ${MESSAGE_MAX_LENGTH} 字符` }, 400);
  }
  const trimmedMessage = message.trim();

  // Validate history payload
  const historyRaw = Array.isArray(payload.history) ? payload.history : [];
  const history = historyRaw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      role: item.role,
      content: item.content,
    }))
    .filter((item): item is { role: 'user' | 'assistant'; content: string } =>
      (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim().length > 0
    )
    .slice(-16);

  const autoWriteback = payload.auto_writeback !== false;

  // Handle image: inline base64 OR R2 key
  let imageUrl: string | null = null;
  let imageDataUri: string | null = null;
  const inlineImage = payload.image;
  const imageKey = payload.image_key;

  if (typeof inlineImage === 'string' && inlineImage.startsWith('data:image/')) {
    imageDataUri = inlineImage;
    try {
      const match = inlineImage.match(/^data:image\/([\w+]+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const raw = match[2];
        const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
        const key = `chat-images/${userId}/${crypto.randomUUID()}.${ext}`;
        await c.env.R2.put(key, bytes, { httpMetadata: { contentType: `image/${match[1]}` } });
        imageUrl = key;
      }
    } catch {
      // ignore R2 save failure, still keep inline for model call
    }
  } else if (typeof imageKey === 'string' && imageKey.startsWith(`chat-images/${userId}/`)) {
    try {
      const object = await c.env.R2.get(imageKey);
      if (object) {
        const arrayBuffer = await object.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        const mimeType = object.httpMetadata?.contentType || 'image/jpeg';
        imageDataUri = `data:${mimeType};base64,${base64}`;
        imageUrl = imageKey;
      }
    } catch {
      // ignore image read failure
    }
  }

  try {
    const result = await runAutoOrchestrate({
      env: c.env,
      userId,
      message: trimmedMessage,
      history,
      imageDataUri,
      imageUrl,
      autoWriteback,
    });

    return c.json({ success: true, data: result });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : '智能会诊失败';
    return c.json({ success: false, error: errMsg }, 502);
  }
});

// GET /api/ai/history?role=xxx
aiRoutes.get('/history', async (c) => {
  const userId = c.get('userId');
  const role = c.req.query('role');

  if (!isEnumValue(role, VALID_ROLES)) {
    return c.json({ success: false, error: '无效的 AI 角色' }, 400);
  }

  const { results } = await c.env.DB.prepare(
    'SELECT id, user_id, role, message_role, content, image_url, created_at FROM chat_history WHERE user_id = ? AND role = ? ORDER BY created_at ASC LIMIT 100'
  )
    .bind(userId, role)
    .all();

  return c.json({ success: true, data: { messages: results } });
});

// POST /api/ai/orchestrate/stream — SSE streaming orchestrate (Supervisor Multi-Agent)
aiRoutes.post('/orchestrate/stream', aiChatRateLimit, async (c) => {
  const userId = c.get('userId');
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(payload)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const message = payload.message;
  if (!isNonEmptyString(message)) {
    return c.json({ success: false, error: '消息不能为空' }, 400);
  }
  if (message.length > MESSAGE_MAX_LENGTH) {
    return c.json({ success: false, error: `消息长度不能超过 ${MESSAGE_MAX_LENGTH} 字符` }, 400);
  }
  const trimmedMessage = message.trim();

  // Validate history payload
  const historyRaw = Array.isArray(payload.history) ? payload.history : [];
  const history: OrchestrateHistoryMessage[] = historyRaw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      role: item.role,
      content: item.content,
    }))
    .filter((item): item is { role: 'user' | 'assistant'; content: string } =>
      (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim().length > 0
    )
    .slice(-MAX_HISTORY_MESSAGES);

  // Handle image: inline base64 OR R2 key
  let imageUrl: string | null = null;
  let imageDataUri: string | null = null;
  const inlineImage = payload.image;
  const imageKey = payload.image_key;

  if (typeof inlineImage === 'string' && inlineImage.startsWith('data:image/')) {
    imageDataUri = inlineImage;
    try {
      const match = inlineImage.match(/^data:image\/([\w+]+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const raw = match[2];
        const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
        const key = `chat-images/${userId}/${crypto.randomUUID()}.${ext}`;
        await c.env.R2.put(key, bytes, { httpMetadata: { contentType: `image/${match[1]}` } });
        imageUrl = key;
      }
    } catch {
      // ignore R2 save failure
    }
  } else if (typeof imageKey === 'string' && imageKey.startsWith(`chat-images/${userId}/`)) {
    try {
      const object = await c.env.R2.get(imageKey);
      if (object) {
        const arrayBuffer = await object.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        const mimeType = object.httpMetadata?.contentType || 'image/jpeg';
        imageDataUri = `data:${mimeType};base64,${base64}`;
        imageUrl = imageKey;
      }
    } catch {
      // ignore image read failure
    }
  }

  // Set up SSE stream
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const sseWriter = new SSEStreamWriter(writable.getWriter());

  // All heavy work runs inside this async IIFE while the Response streams out
  void (async () => {
    let fullContent = '';

    try {
      // Step 1: Route to the best role
      await sseWriter.sendStatus('正在评估您的情况...');
      let routing;
      try {
        routing = await decideRoute(c.env, trimmedMessage, history);
      } catch {
        routing = { primaryRole: 'trainer' as const, collaborators: [] as AIRole[], reason: '兜底路由' };
      }
      const primaryRole = routing.primaryRole;

      // Step 2: Send routing event
      const routingEvent: SSERoutingEvent = {
        primary_role: primaryRole,
        primary_role_name: ROLE_NAMES[primaryRole],
        collaborators: routing.collaborators.map((r) => ({ role: r, role_name: ROLE_NAMES[r] })),
        reason: routing.reason,
      };
      await sseWriter.sendRouting(routingEvent);

      // Step 3: Fetch user context
      await sseWriter.sendStatus('正在查阅你的档案...');
      let userContext;
      try {
        userContext = await getUserContext(c.env.DB, userId);
      } catch {
        await sseWriter.sendError('获取用户上下文失败，请稍后重试');
        return;
      }

      // Step 4: Stream primary agent
      await sseWriter.sendStatus(`正在呼叫【${ROLE_NAMES[primaryRole]}】...`);
      fullContent = await streamPrimaryAgent({
        env: c.env,
        role: primaryRole,
        userContext,
        history,
        message: trimmedMessage,
        imageDataUri,
        writer: sseWriter,
      });

      // Step 5: Generate collaborator supplements (if any)
      let supplements: Array<{ role: AIRole; content: string }> = [];
      if (routing.collaborators.length > 0) {
        await sseWriter.sendStatus('正在收集专家补充意见...');
        try {
          supplements = await generateCollaboratorSupplements(
            c.env,
            routing.collaborators,
            userContext,
            trimmedMessage,
            primaryRole,
            fullContent
          );
          // Send each supplement as a separate SSE event
          for (const supplement of supplements) {
            await sseWriter.sendSupplement(supplement.role, ROLE_NAMES[supplement.role], supplement.content);
          }
        } catch {
          // Supplements are non-critical, continue
        }
      }

      // Step 6: Save history with metadata
      if (fullContent.trim().length > 0) {
        await sseWriter.sendStatus('正在保存会话...');
        const metadata: Record<string, unknown> = {
          primary_role: primaryRole,
          collaborators: routing.collaborators,
          routing_reason: routing.reason,
        };
        if (supplements.length > 0) {
          metadata.supplements = supplements.map((s) => ({ role: s.role, content: s.content }));
        }
        try {
          await saveOrchestrateHistory(c.env.DB, userId, trimmedMessage, fullContent, imageUrl, metadata);
        } catch (error) {
          const logKey = `log:orchestrate-stream-save-error:${Date.now()}:${crypto.randomUUID()}`;
          try {
            await c.env.KV.put(logKey, JSON.stringify({
              userId,
              error: error instanceof Error ? error.message : '保存历史失败',
              at: new Date().toISOString(),
            }), { expirationTtl: 60 * 60 * 24 * 7 });
          } catch {
            // ignore KV write failure
          }
        }

        // Step 7: Writeback
        await sseWriter.sendStatus('正在同步你的训练档案...');
        try {
          const { payload: writebackPayload, extractionError } = await resolveWritebackPayload(
            c.env,
            trimmedMessage,
            history,
            fullContent
          );
          const writebackSummary = await applyAutoWriteback(c.env.DB, userId, writebackPayload);
          const isWritebackFailed = Boolean(extractionError) && !hasWritebackChanges(writebackSummary);

          if (isWritebackFailed) {
            const errorMsg = extractionError || '自动写回失败';
            await sseWriter.sendWritebackError(errorMsg);
            c.executionCtx.waitUntil(
              recordWritebackAudit(c.env.DB, userId, 'orchestrate_stream', null, errorMsg, trimmedMessage).catch(() => {})
            );
          } else {
            await sseWriter.sendWriteback(writebackSummary);
            c.executionCtx.waitUntil(
              recordWritebackAudit(c.env.DB, userId, 'orchestrate_stream', writebackSummary, null, trimmedMessage).catch(() => {})
            );
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : '自动写回失败';
          await sseWriter.sendWritebackError(errMsg);
          const logKey = `log:orchestrate-stream-writeback-error:${Date.now()}:${crypto.randomUUID()}`;
          try {
            await c.env.KV.put(logKey, JSON.stringify({
              userId,
              error: errMsg,
              at: new Date().toISOString(),
            }), { expirationTtl: 60 * 60 * 24 * 7 });
          } catch {
            // ignore KV write failure
          }
          c.executionCtx.waitUntil(
            recordWritebackAudit(c.env.DB, userId, 'orchestrate_stream', null, errMsg, trimmedMessage).catch(() => {})
          );
        }
      }

      // Step 8: Done
      await sseWriter.sendDone();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '流式响应中断';
      await sseWriter.sendError(errMsg);
    } finally {
      await sseWriter.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

// GET /api/ai/orchestrate/history
aiRoutes.get('/orchestrate/history', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    'SELECT id, message_role, content, image_url, metadata, created_at FROM chat_history WHERE user_id = ? AND role = ? ORDER BY created_at ASC LIMIT 100'
  )
    .bind(userId, ORCHESTRATOR_ROLE)
    .all();

  return c.json({ success: true, data: { messages: results } });
});

// GET /api/ai/orchestrate/writeback-audits?limit=20
aiRoutes.get('/orchestrate/writeback-audits', async (c) => {
  const userId = c.get('userId');
  const rawLimit = parseInt(c.req.query('limit') || '20', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
  const { results } = await c.env.DB.prepare(
    'SELECT id, source, status, summary_json, error, message_excerpt, created_at FROM ai_writeback_audits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  )
    .bind(userId, limit)
    .all<{
      id: string;
      source: string;
      status: string;
      summary_json: string | null;
      error: string | null;
      message_excerpt: string | null;
      created_at: string;
    }>();

  const audits = results.map((item) => {
    let summary: unknown = null;
    if (item.summary_json) {
      try {
        summary = JSON.parse(item.summary_json);
      } catch {
        summary = null;
      }
    }
    return {
      id: item.id,
      source: item.source,
      status: item.status,
      summary,
      error: item.error,
      message_excerpt: item.message_excerpt,
      created_at: item.created_at,
    };
  });

  return c.json({ success: true, data: { audits } });
});

// DELETE /api/ai/history?role=xxx - Clear chat history for a role
aiRoutes.delete('/history', async (c) => {
  const userId = c.get('userId');
  const role = c.req.query('role');

  if (!isEnumValue(role, VALID_ROLES)) {
    return c.json({ success: false, error: '无效的 AI 角色' }, 400);
  }

  await c.env.DB.prepare('DELETE FROM chat_history WHERE user_id = ? AND role = ?')
    .bind(userId, role)
    .run();

  return c.json({ success: true });
});

// DELETE /api/ai/orchestrate/history
aiRoutes.delete('/orchestrate/history', async (c) => {
  const userId = c.get('userId');
  await c.env.DB.prepare('DELETE FROM chat_history WHERE user_id = ? AND role = ?')
    .bind(userId, ORCHESTRATOR_ROLE)
    .run();

  return c.json({ success: true });
});
