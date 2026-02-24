import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { isNumberInRange, isPlainObject, isISODateString, isEnumValue } from '../utils/validate';

export const dailyLogRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

dailyLogRoutes.use('*', authMiddleware);

const SLEEP_QUALITIES = ['good', 'fair', 'poor'] as const;

// GET /api/daily-logs?date=YYYY-MM-DD
dailyLogRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const date = c.req.query('date');

  if (date) {
    const row = await c.env.DB.prepare(
      'SELECT * FROM daily_logs WHERE user_id = ? AND log_date = ?'
    )
      .bind(userId, date)
      .first();
    return c.json({ success: true, data: row || null });
  }

  const limit = parseInt(c.req.query('limit') || '30');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM daily_logs WHERE user_id = ? ORDER BY log_date DESC LIMIT ?'
  )
    .bind(userId, limit)
    .all();

  return c.json({ success: true, data: results });
});

// PUT /api/daily-logs — upsert by (user_id, log_date)
dailyLogRoutes.put('/', async (c) => {
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

  const { log_date, weight, sleep_hours, sleep_quality, note } = payload;

  if (!isISODateString(log_date)) {
    return c.json({ success: false, error: 'log_date 必须为 YYYY-MM-DD 格式' }, 400);
  }

  if (weight !== undefined && weight !== null && !isNumberInRange(weight, 20, 500)) {
    return c.json({ success: false, error: 'weight 必须在 20-500 之间（kg）' }, 400);
  }

  if (sleep_hours !== undefined && sleep_hours !== null && !isNumberInRange(sleep_hours, 0, 24)) {
    return c.json({ success: false, error: 'sleep_hours 必须在 0-24 之间' }, 400);
  }

  if (sleep_quality !== undefined && sleep_quality !== null && !isEnumValue(sleep_quality, SLEEP_QUALITIES)) {
    return c.json({ success: false, error: 'sleep_quality 必须为 good / fair / poor' }, 400);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO daily_logs (id, user_id, log_date, weight, sleep_hours, sleep_quality, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       weight = COALESCE(excluded.weight, daily_logs.weight),
       sleep_hours = COALESCE(excluded.sleep_hours, daily_logs.sleep_hours),
       sleep_quality = COALESCE(excluded.sleep_quality, daily_logs.sleep_quality),
       note = COALESCE(excluded.note, daily_logs.note)`
  )
    .bind(
      id,
      userId,
      log_date as string,
      (weight as number) ?? null,
      (sleep_hours as number) ?? null,
      (sleep_quality as string) ?? null,
      (note as string) ?? null
    )
    .run();

  // Return the actual row
  const row = await c.env.DB.prepare(
    'SELECT * FROM daily_logs WHERE user_id = ? AND log_date = ?'
  )
    .bind(userId, log_date as string)
    .first();

  return c.json({ success: true, data: row });
});
