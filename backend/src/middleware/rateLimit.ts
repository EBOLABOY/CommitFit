import { createMiddleware } from 'hono/factory';
import type { Bindings, Variables } from '../types';

type RateLimitTarget = 'ip' | 'user';

type RateLimitOptions = {
  key: string;
  limit: number;
  windowSeconds: number;
  target: RateLimitTarget;
  message?: string;
};

type RateLimitState = {
  timestamps: number[];
};

function getClientIP(headers: Headers): string {
  const cfIp = headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;

  const forwardedFor = headers.get('X-Forwarded-For');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

function getRateLimitKey(
  target: RateLimitTarget,
  key: string,
  userId: string | undefined,
  headers: Headers
): string {
  if (target === 'user' && userId) {
    return `rate:${key}:user:${userId}`;
  }

  const ip = getClientIP(headers);
  return `rate:${key}:ip:${ip}`;
}

export function createRateLimit(options: RateLimitOptions) {
  return createMiddleware<{ Bindings: Bindings; Variables: Variables }>(async (c, next) => {
    const storageKey = getRateLimitKey(options.target, options.key, c.get('userId'), c.req.raw.headers);
    const now = Date.now();
    const windowMs = options.windowSeconds * 1000;
    const ttlSeconds = options.windowSeconds + 30;

    try {
      const existing = await c.env.KV.get(storageKey, 'json');
      const existingState = existing && typeof existing === 'object' ? (existing as RateLimitState) : null;
      const timestamps = (existingState?.timestamps || []).filter((ts) => ts > now - windowMs);

      if (timestamps.length >= options.limit) {
        const retryAfter = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
        return c.json(
          {
            success: false,
            error: options.message || '请求过于频繁，请稍后再试',
          },
          429,
          {
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(options.limit),
            'X-RateLimit-Remaining': '0',
          }
        );
      }

      timestamps.push(now);
      await c.env.KV.put(storageKey, JSON.stringify({ timestamps }), { expirationTtl: ttlSeconds });

      const remaining = Math.max(0, options.limit - timestamps.length);
      c.header('X-RateLimit-Limit', String(options.limit));
      c.header('X-RateLimit-Remaining', String(remaining));
    } catch (error) {
      // 限流状态读取失败时放行请求，避免因外部存储异常导致服务不可用。
      console.error('[rate-limit] failed:', error);
    }

    await next();
  });
}
