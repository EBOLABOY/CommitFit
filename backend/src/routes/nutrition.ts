import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';

export const nutritionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

nutritionRoutes.use('*', authMiddleware);

// GET /api/nutrition
nutritionRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') || '10');

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM nutrition_plans WHERE user_id = ? ORDER BY plan_date DESC LIMIT ?'
  )
    .bind(userId, limit)
    .all();

  return c.json({ success: true, data: results });
});

// POST /api/nutrition
nutritionRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const { plan_date, content } = await c.req.json();

  if (!plan_date || !content) {
    return c.json({ success: false, error: '日期和内容不能为空' }, 400);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    'INSERT INTO nutrition_plans (id, user_id, plan_date, content) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, plan_date, typeof content === 'string' ? content : JSON.stringify(content))
    .run();

  return c.json({ success: true, data: { id } });
});

// POST /api/nutrition/photo - Upload food photo to R2
nutritionRoutes.post('/photo', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const formData = await c.req.formData();
  const file = formData.get('photo') as File | null;

  if (!file) {
    return c.json({ success: false, error: '请上传照片' }, 400);
  }

  const key = `food-photos/${userId}/${Date.now()}-${file.name}`;
  await c.env.R2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  return c.json({ success: true, data: { key } });
});
