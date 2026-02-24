import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { isEnumValue, isNonEmptyString, isPlainObject, isStringMaxLength } from '../utils/validate';

export const trainingGoalRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

trainingGoalRoutes.use('*', authMiddleware);

const STATUS_VALUES = ['active', 'completed'] as const;

// GET /api/training-goals
trainingGoalRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const status = c.req.query('status');

  let query = 'SELECT * FROM training_goals WHERE user_id = ?';
  const params: string[] = [userId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const { results } = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({ success: true, data: results });
});

// POST /api/training-goals
trainingGoalRoutes.post('/', async (c) => {
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

  const { name, description } = payload;

  if (!isNonEmptyString(name) || name.length > 100) {
    return c.json({ success: false, error: 'name 不能为空且长度不能超过 100 字符' }, 400);
  }
  if (description !== undefined && description !== null && !isStringMaxLength(description, 500)) {
    return c.json({ success: false, error: 'description 长度不能超过 500 字符' }, 400);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    'INSERT INTO training_goals (id, user_id, name, description) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, name.trim(), description || null)
    .run();

  return c.json({
    success: true,
    data: { id, user_id: userId, name: name.trim(), description: description || null, status: 'active' },
  });
});

// PUT /api/training-goals/:id
trainingGoalRoutes.put('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(payload)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }
  const body = payload;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name) || body.name.length > 100) {
      return c.json({ success: false, error: 'name 不能为空且长度不能超过 100 字符' }, 400);
    }
    fields.push('name = ?');
    values.push(body.name.trim());
  }

  if (body.description !== undefined) {
    if (body.description !== null && !isStringMaxLength(body.description, 500)) {
      return c.json({ success: false, error: 'description 长度不能超过 500 字符' }, 400);
    }
    fields.push('description = ?');
    values.push(body.description);
  }

  if (body.status !== undefined) {
    if (!isEnumValue(body.status, STATUS_VALUES)) {
      return c.json({ success: false, error: 'status 只能是 active/completed' }, 400);
    }
    fields.push('status = ?');
    values.push(body.status);
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: '没有提供更新字段' }, 400);
  }

  values.push(id, userId);

  const result = await c.env.DB.prepare(
    `UPDATE training_goals SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`
  )
    .bind(...values)
    .run();

  if (!result.meta.changes) {
    return c.json({ success: false, error: '未找到该记录' }, 404);
  }

  return c.json({ success: true });
});

// DELETE /api/training-goals/:id
trainingGoalRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const result = await c.env.DB.prepare(
    'DELETE FROM training_goals WHERE id = ? AND user_id = ?'
  )
    .bind(id, userId)
    .run();

  if (!result.meta.changes) {
    return c.json({ success: false, error: '未找到该记录' }, 404);
  }

  return c.json({ success: true });
});
