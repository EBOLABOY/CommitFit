import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { agentsMiddleware } from 'hono-agents';
import type { Bindings, Variables } from './types';
import { authRoutes } from './routes/auth';
import { profileRoutes } from './routes/profile';
import { healthRoutes } from './routes/health';
import { conditionsRoutes } from './routes/conditions';
import { trainingRoutes } from './routes/training';
import { nutritionRoutes } from './routes/nutrition';
import { imageRoutes } from './routes/images';
import { dietRoutes } from './routes/diet';
import { dailyLogRoutes } from './routes/daily-logs';
import { trainingGoalRoutes } from './routes/training-goals';
import { writebackRoutes } from './routes/writeback';
import { SupervisorAgent } from './agents/supervisor-agent';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:8081', 'http://localhost:19006'];

function resolveAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  const parsed = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_ORIGINS;
}

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowedOrigins = resolveAllowedOrigins(c.env.ALLOWED_ORIGINS);
      if (!origin) return undefined;
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);

app.use('/agents/*', agentsMiddleware());

app.get('/', (c) => c.json({ message: '练了码 API v1' }));

app.route('/api/auth', authRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/health', healthRoutes);
app.route('/api/conditions', conditionsRoutes);
app.route('/api/training', trainingRoutes);
app.route('/api/nutrition', nutritionRoutes);
app.route('/api/images', imageRoutes);
app.route('/api/diet', dietRoutes);
app.route('/api/daily-logs', dailyLogRoutes);
app.route('/api/training-goals', trainingGoalRoutes);
app.route('/api/writeback', writebackRoutes);

export default app;
export {
  SupervisorAgent,
};
