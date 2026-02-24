import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { isEnumValue, isNumberInRange, isPlainObject } from '../utils/validate';

export const profileRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

profileRoutes.use('*', authMiddleware);

const GENDER_VALUES = ['male', 'female'] as const;
const EXPERIENCE_VALUES = ['beginner', 'intermediate', 'advanced'] as const;

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

  if (body.age !== undefined) {
    if (!isNumberInRange(body.age, 1, 150)) {
      return c.json({ success: false, error: 'age 必须在 1-150 之间' }, 400);
    }
    fields.push('age = ?');
    values.push(body.age);
  }

  if (body.gender !== undefined) {
    if (!isEnumValue(body.gender, GENDER_VALUES)) {
      return c.json({ success: false, error: 'gender 只能是 male 或 female' }, 400);
    }
    fields.push('gender = ?');
    values.push(body.gender);
  }

  if (body.experience_level !== undefined) {
    if (!isEnumValue(body.experience_level, EXPERIENCE_VALUES)) {
      return c.json(
        { success: false, error: 'experience_level 只能是 beginner/intermediate/advanced' },
        400
      );
    }
    fields.push('experience_level = ?');
    values.push(body.experience_level);
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
