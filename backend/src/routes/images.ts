import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';

export const imageRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

imageRoutes.use('*', authMiddleware);

// POST /api/images/upload — upload an image to R2 via FormData
imageRoutes.post('/upload', async (c) => {
  const userId = c.get('userId');

  const body = await c.req.parseBody();
  const file = body['image'];

  if (!(file instanceof File)) {
    return c.json({ success: false, error: '缺少图片文件' }, 400);
  }

  if (file.size > 10 * 1024 * 1024) {
    return c.json({ success: false, error: '图片不能超过 10MB' }, 400);
  }

  const ext = file.type === 'image/png' ? 'png' : 'jpg';
  const key = `chat-images/${userId}/${crypto.randomUUID()}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  await c.env.R2.put(key, arrayBuffer, {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });

  return c.json({ success: true, data: { key } });
});

// GET /api/images/:key+ — serve an image from R2
imageRoutes.get('/*', async (c) => {
  const key = c.req.path.replace('/api/images/', '');
  if (!key) {
    return c.json({ success: false, error: '缺少图片路径' }, 400);
  }

  // Ensure user can only access their own images
  const userId = c.get('userId');
  if (!key.startsWith(`chat-images/${userId}/`)) {
    return c.json({ success: false, error: '无权访问' }, 403);
  }

  const object = await c.env.R2.get(key);
  if (!object) {
    return c.json({ success: false, error: '图片不存在' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'private, max-age=86400');

  return new Response(object.body as ReadableStream, { headers });
});
