import { createMiddleware } from 'hono/factory';
import { SignJWT, jwtVerify } from 'jose';
import type { Bindings, Variables } from '../types';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BITS = 256;
const SALT_LENGTH_BYTES = 16;
const PASSWORD_CHANGED_KV_PREFIX = 'pwd_changed';

export const authMiddleware = createMiddleware<{
  Bindings: Bindings;
  Variables: Variables;
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ success: false, error: '未提供认证令牌' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) {
      return c.json({ success: false, error: '令牌无效或已过期' }, 401);
    }

    const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
    let passwordChangedAt: string | null = null;
    try {
      passwordChangedAt = await c.env.KV.get(`${PASSWORD_CHANGED_KV_PREFIX}:${userId}`);
    } catch (error) {
      console.error('[auth] read password changed timestamp failed:', error);
    }

    if (passwordChangedAt) {
      const changedAt = Number(passwordChangedAt);
      if (Number.isFinite(changedAt) && issuedAt > 0 && issuedAt < changedAt) {
        return c.json({ success: false, error: '登录状态已失效，请重新登录' }, 401);
      }
    }

    c.set('userId', userId);
    c.set('tokenIssuedAt', issuedAt);
    await next();
  } catch {
    return c.json({ success: false, error: '令牌无效或已过期' }, 401);
  }
});

export async function createToken(userId: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('无效的十六进制字符串');
  }

  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

async function derivePasswordHash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hashBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    passwordKey,
    PBKDF2_HASH_BITS
  );

  return new Uint8Array(hashBits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const hash = await derivePasswordHash(password, salt);
  return `${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) {
      return false;
    }

    const salt = fromHex(saltHex);
    const expectedHash = fromHex(hashHex);
    const actualHash = await derivePasswordHash(password, salt);
    return constantTimeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}
