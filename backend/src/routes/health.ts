import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  isEnumValue,
  isISODateString,
  isNonEmptyString,
  isPlainObject,
  isStringMaxLength,
} from '../utils/validate';

export const healthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

healthRoutes.use('*', authMiddleware);

const METRIC_TYPES = [
  'testosterone',
  'blood_pressure',
  'blood_lipids',
  'blood_sugar',
  'heart_rate',
  'body_fat',
  'other',
] as const;

// GET /api/health
healthRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const metricType = c.req.query('metric_type');

  let query = 'SELECT * FROM health_metrics WHERE user_id = ?';
  const params: string[] = [userId];

  if (metricType) {
    query += ' AND metric_type = ?';
    params.push(metricType);
  }

  query += ' ORDER BY recorded_at DESC';

  const { results } = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({ success: true, data: results });
});

// POST /api/health
healthRoutes.post('/', async (c) => {
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

  const { metric_type, value, unit, recorded_at } = payload;

  if (!isEnumValue(metric_type, METRIC_TYPES)) {
    return c.json({ success: false, error: 'metric_type 无效' }, 400);
  }
  if (!isNonEmptyString(value)) {
    return c.json({ success: false, error: 'value 不能为空' }, 400);
  }
  if (unit !== undefined && unit !== null && !isStringMaxLength(unit, 20)) {
    return c.json({ success: false, error: 'unit 长度不能超过 20 字符' }, 400);
  }
  if (recorded_at !== undefined && recorded_at !== null && !isISODateString(recorded_at)) {
    return c.json({ success: false, error: 'recorded_at 必须是 ISO 日期格式' }, 400);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    'INSERT INTO health_metrics (id, user_id, metric_type, value, unit, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, metric_type, value.trim(), unit || null, recorded_at || null)
    .run();

  return c.json({
    success: true,
    data: { id, user_id: userId, metric_type, value, unit, recorded_at },
  });
});

// DELETE /api/health/:id
healthRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const result = await c.env.DB.prepare(
    'DELETE FROM health_metrics WHERE id = ? AND user_id = ?'
  )
    .bind(id, userId)
    .run();

  if (!result.meta.changes) {
    return c.json({ success: false, error: '未找到该记录' }, 404);
  }

  return c.json({ success: true });
});
