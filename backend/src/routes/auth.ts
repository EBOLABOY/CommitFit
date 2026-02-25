import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware, createToken, hashPassword, verifyPassword } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import {
  isEmail,
  isNonEmptyString,
  isPlainObject,
  isStringMaxLength,
  normalizeString,
} from '../utils/validate';

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const PASSWORD_MIN_LENGTH = 8;
const NICKNAME_MAX_LENGTH = 50;
const AVATAR_KEY_MAX_LENGTH = 512;
const PASSWORD_CHANGED_KV_PREFIX = 'pwd_changed';

function isValidAvatarKeyForUser(key: string, userId: string): boolean {
  return key.startsWith(`chat-images/${userId}/`);
}

const loginRateLimit = createRateLimit({
  key: 'auth-login',
  limit: 10,
  windowSeconds: 60,
  target: 'ip',
  message: '登录请求过于频繁，请 1 分钟后重试',
});

const registerRateLimit = createRateLimit({
  key: 'auth-register',
  limit: 5,
  windowSeconds: 3600,
  target: 'ip',
  message: '注册请求过于频繁，请 1 小时后重试',
});

// POST /api/auth/register
authRoutes.post('/register', registerRateLimit, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(body)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const email = body.email;
  const password = body.password;
  const nickname = body.nickname;

  if (!isEmail(email)) {
    return c.json({ success: false, error: '邮箱格式不正确' }, 400);
  }
  if (!isNonEmptyString(password) || password.length < PASSWORD_MIN_LENGTH) {
    return c.json({ success: false, error: `密码长度不能少于 ${PASSWORD_MIN_LENGTH} 位` }, 400);
  }
  if (nickname !== undefined && nickname !== null && !isStringMaxLength(nickname, NICKNAME_MAX_LENGTH)) {
    return c.json({ success: false, error: `昵称长度不能超过 ${NICKNAME_MAX_LENGTH} 字符` }, 400);
  }

  const normalizedEmail = normalizeString(email).toLowerCase();
  const normalizedNickname = typeof nickname === 'string' ? normalizeString(nickname) : null;

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(normalizedEmail)
    .first();
  if (existing) {
    return c.json({ success: false, error: '该邮箱已注册' }, 409);
  }

  const id = crypto.randomUUID();
  const password_hash = await hashPassword(password);

  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, nickname, avatar_key) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, normalizedEmail, password_hash, normalizedNickname || null, null)
    .run();

  // Create empty profile
  await c.env.DB.prepare('INSERT INTO user_profiles (user_id) VALUES (?)').bind(id).run();

  const token = await createToken(id, c.env.JWT_SECRET);

  return c.json({
    success: true,
    data: {
      token,
      user: { id, email: normalizedEmail, nickname: normalizedNickname || null, avatar_key: null },
    },
  });
});

// POST /api/auth/login
authRoutes.post('/login', loginRateLimit, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(body)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const email = body.email;
  const password = body.password;
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return c.json({ success: false, error: '邮箱和密码不能为空' }, 400);
  }

  const normalizedEmail = normalizeString(email).toLowerCase();

  const user = await c.env.DB.prepare(
    'SELECT id, email, password_hash, nickname, avatar_key FROM users WHERE email = ?'
  )
    .bind(normalizedEmail)
    .first<{ id: string; email: string; password_hash: string; nickname: string | null; avatar_key: string | null }>();

  if (!user) {
    return c.json({ success: false, error: '邮箱或密码错误' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ success: false, error: '邮箱或密码错误' }, 401);
  }

  const token = await createToken(user.id, c.env.JWT_SECRET);

  return c.json({
    success: true,
    data: {
      token,
      user: { id: user.id, email: user.email, nickname: user.nickname, avatar_key: user.avatar_key },
    },
  });
});

// GET /api/auth/me
authRoutes.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare('SELECT id, email, nickname, avatar_key FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; nickname: string | null; avatar_key: string | null }>();

  if (!user) {
    return c.json({ success: false, error: '用户不存在' }, 404);
  }

  return c.json({ success: true, data: user });
});

// PUT /api/auth/me
authRoutes.put('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(body)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.nickname !== undefined) {
    if (body.nickname !== null && !isStringMaxLength(body.nickname, NICKNAME_MAX_LENGTH)) {
      return c.json({ success: false, error: `昵称长度不能超过 ${NICKNAME_MAX_LENGTH} 字符` }, 400);
    }

    if (typeof body.nickname === 'string') {
      const normalizedNickname = normalizeString(body.nickname);
      fields.push('nickname = ?');
      values.push(normalizedNickname || null);
    } else if (body.nickname === null) {
      fields.push('nickname = ?');
      values.push(null);
    } else {
      return c.json({ success: false, error: 'nickname 必须是字符串或 null' }, 400);
    }
  }

  if (body.avatar_key !== undefined) {
    if (body.avatar_key === null) {
      fields.push('avatar_key = ?');
      values.push(null);
    } else if (typeof body.avatar_key === 'string') {
      const avatarKey = normalizeString(body.avatar_key);
      if (!avatarKey) {
        fields.push('avatar_key = ?');
        values.push(null);
      } else {
        if (avatarKey.length > AVATAR_KEY_MAX_LENGTH) {
          return c.json({ success: false, error: `avatar_key 长度不能超过 ${AVATAR_KEY_MAX_LENGTH}` }, 400);
        }
        if (!isValidAvatarKeyForUser(avatarKey, userId)) {
          return c.json({ success: false, error: 'avatar_key 非法或无权限' }, 400);
        }
        fields.push('avatar_key = ?');
        values.push(avatarKey);
      }
    } else {
      return c.json({ success: false, error: 'avatar_key 必须是字符串或 null' }, 400);
    }
  }

  if (fields.length === 0) {
    return c.json({ success: false, error: '没有提供更新字段' }, 400);
  }

  values.push(userId);
  await c.env.DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const user = await c.env.DB.prepare('SELECT id, email, nickname, avatar_key FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; nickname: string | null; avatar_key: string | null }>();

  if (!user) {
    return c.json({ success: false, error: '用户不存在' }, 404);
  }

  return c.json({ success: true, data: user });
});

// PUT /api/auth/password
authRoutes.put('/password', authMiddleware, async (c) => {
  const userId = c.get('userId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(body)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const oldPassword = body.old_password;
  const newPassword = body.new_password;

  if (!isNonEmptyString(oldPassword) || !isNonEmptyString(newPassword)) {
    return c.json({ success: false, error: '旧密码和新密码不能为空' }, 400);
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return c.json({ success: false, error: `新密码长度不能少于 ${PASSWORD_MIN_LENGTH} 位` }, 400);
  }
  if (oldPassword === newPassword) {
    return c.json({ success: false, error: '新密码不能与旧密码相同' }, 400);
  }

  const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string }>();

  if (!user) {
    return c.json({ success: false, error: '用户不存在' }, 404);
  }

  const valid = await verifyPassword(oldPassword, user.password_hash);
  if (!valid) {
    return c.json({ success: false, error: '旧密码错误' }, 401);
  }

  const nextPasswordHash = await hashPassword(newPassword);
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(nextPasswordHash, userId)
    .run();

  const passwordChangedAt = Math.floor(Date.now() / 1000);
  await c.env.KV.put(`${PASSWORD_CHANGED_KV_PREFIX}:${userId}`, String(passwordChangedAt), {
    expirationTtl: 60 * 60 * 24 * 365 * 5,
  });

  const token = await createToken(userId, c.env.JWT_SECRET);
  return c.json({ success: true, data: { token } });
});

// DELETE /api/auth/account
authRoutes.delete('/account', authMiddleware, async (c) => {
  const userId = c.get('userId');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM ai_writeback_audits WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM chat_history WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM diet_records WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM daily_logs WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM nutrition_plans WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM training_plans WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM training_goals WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM conditions WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM health_metrics WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM user_profiles WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);

  await c.env.KV.delete(`${PASSWORD_CHANGED_KV_PREFIX}:${userId}`);

  return c.json({ success: true });
});
