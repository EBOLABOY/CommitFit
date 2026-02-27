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
import { agentRuntimeRoutes } from './routes/agent-runtime';
import { SupervisorAgent } from './agents/supervisor-agent';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:8081', 'http://localhost:19006'];
const AGENT_ROUTE_ERROR = 'AGENT_ROUTE_FAILED';

function isAgentDebugEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

function toErrorObject(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || 'unknown_error',
      stack: typeof error.stack === 'string' ? error.stack : undefined,
    };
  }
  const message = typeof error === 'string'
    ? error
    : (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    })();
  return { name: 'UnknownError', message };
}

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

const rawAgentsMiddleware = agentsMiddleware<{ Bindings: Bindings; Variables: Variables }>();

app.use('/agents/*', async (c, next) => {
  try {
    return await rawAgentsMiddleware(c, next);
  } catch (error) {
    const requestUrl = new URL(c.req.url);
    const isWebSocket = c.req.header('upgrade')?.toLowerCase() === 'websocket';
    const errorId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const debugEnabled = isAgentDebugEnabled(c.env.AGENT_DEBUG_ENABLED);
    const normalized = toErrorObject(error);

    console.error('[agents] route failed', {
      error_id: errorId,
      method: c.req.method,
      path: requestUrl.pathname,
      ws: isWebSocket,
      name: normalized.name,
      message: normalized.message,
      stack: normalized.stack,
    });

    const headers = new Headers({ 'x-agent-error-id': errorId });
    if (debugEnabled) {
      headers.set('x-agent-error', normalized.name);
    }

    if (isWebSocket) {
      const body = debugEnabled
        ? `${AGENT_ROUTE_ERROR}:${errorId}:${normalized.message}`
        : `${AGENT_ROUTE_ERROR}:${errorId}`;
      return new Response(body, { status: 500, headers });
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: AGENT_ROUTE_ERROR,
        error_id: errorId,
        ...(debugEnabled
          ? {
            debug: {
              name: normalized.name,
              message: normalized.message,
            },
          }
          : {}),
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-agent-error-id': errorId,
          ...(debugEnabled ? { 'x-agent-error': normalized.name } : {}),
        },
      }
    );
  }
});

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
app.route('/api/agent', agentRuntimeRoutes);

export default app;
export {
  SupervisorAgent,
};
