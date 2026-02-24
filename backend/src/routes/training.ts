import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';

export const trainingRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

trainingRoutes.use('*', authMiddleware);

// GET /api/training
trainingRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') || '10');

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM training_plans WHERE user_id = ? ORDER BY plan_date DESC LIMIT ?'
  )
    .bind(userId, limit)
    .all();

  return c.json({ success: true, data: results });
});

// POST /api/training
trainingRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const { plan_date, content, notes } = await c.req.json();

  if (!plan_date || !content) {
    return c.json({ success: false, error: '日期和内容不能为空' }, 400);
  }

  // 同一天只保留一个训练计划，新计划覆盖旧计划
  await c.env.DB.prepare(
    'DELETE FROM training_plans WHERE user_id = ? AND plan_date = ?'
  )
    .bind(userId, plan_date)
    .run();

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    'INSERT INTO training_plans (id, user_id, plan_date, content, notes) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, userId, plan_date, typeof content === 'string' ? content : JSON.stringify(content), notes || null)
    .run();

  return c.json({ success: true, data: { id } });
});

// PUT /api/training/:id/complete
trainingRoutes.put('/:id/complete', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  await c.env.DB.prepare(
    'UPDATE training_plans SET completed = 1 WHERE id = ? AND user_id = ?'
  )
    .bind(id, userId)
    .run();

  return c.json({ success: true });
});
