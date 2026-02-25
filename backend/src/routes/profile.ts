import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { isEnumValue, isISODateString, isNumberInRange, isPlainObject } from '../utils/validate';

export const profileRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

profileRoutes.use('*', authMiddleware);

const GENDER_VALUES = ['male', 'female'] as const;

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && isISODateString(value);
}

// GET /api/profile
profileRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  const profile = await c.env.DB.prepare(
    'SELECT * FROM user_profiles WHERE user_id = ?'
  )
    .bind(userId)
    .first();

  if (!profile) {
    return c.json({ success: false, error: '未找到用户档案' }, 404);
  }

  return c.json({ success: true, data: profile });
});

// PUT /api/profile
profileRoutes.put('/', async (c) => {
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
  const body = payload;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.height !== undefined) {
    if (!isNumberInRange(body.height, 50, 300)) {
      return c.json({ success: false, error: 'height 必须在 50-300 之间（cm）' }, 400);
    }
    fields.push('height = ?');
    values.push(body.height);
  }

  if (body.weight !== undefined) {
    if (!isNumberInRange(body.weight, 20, 500)) {
      return c.json({ success: false, error: 'weight 必须在 20-500 之间（kg）' }, 400);
    }
    fields.push('weight = ?');
    values.push(body.weight);
  }

  if (body.birth_date !== undefined) {
    if (body.birth_date === null) {
      fields.push('birth_date = ?');
      values.push(null);
    } else if (typeof body.birth_date === 'string' && isDateOnly(body.birth_date)) {
      fields.push('birth_date = ?');
      values.push(body.birth_date);
    } else {
      return c.json({ success: false, error: 'birth_date 必须是 YYYY-MM-DD 或 null' }, 400);
    }
  }

  if (body.gender !== undefined) {
    if (body.gender !== null && !isEnumValue(body.gender, GENDER_VALUES)) {
      return c.json({ success: false, error: 'gender 只能是 male 或 female' }, 400);
    }
    fields.push('gender = ?');
    values.push(body.gender);
  }

  if (body.training_years !== undefined) {
    if (body.training_years === null) {
      fields.push('training_years = ?');
      values.push(null);
    } else if (isNumberInRange(body.training_years, 0, 80)) {
      fields.push('training_years = ?');
      values.push(Number(body.training_years.toFixed(1)));
    } else {
      return c.json({ success: false, error: 'training_years 必须在 0-80 之间或 null' }, 400);
    }
  }

  if (body.training_goal !== undefined) {
    if (typeof body.training_goal !== 'string' || body.training_goal.length > 200) {
      return c.json({ success: false, error: 'training_goal 长度不能超过 200 字符' }, 400);
    }
    fields.push('training_goal = ?');
    values.push(body.training_goal.trim());
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: '没有提供更新字段' }, 400);
  }

  fields.push("updated_at = datetime('now')");
  values.push(userId);

  await c.env.DB.prepare(
    `UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = ?`
  )
    .bind(...values)
    .run();

  const updated = await c.env.DB.prepare(
    'SELECT * FROM user_profiles WHERE user_id = ?'
  )
    .bind(userId)
    .first();

  return c.json({ success: true, data: updated });
});
