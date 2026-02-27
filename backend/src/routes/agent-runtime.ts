import { Hono } from 'hono';
import { routeAgentRequest } from 'agents';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { buildContextForRole, getUserContext } from '../services/context';
import { ROLE_NAMES, SYSTEM_PROMPTS } from '../services/orchestrator';
import { loadRuntimePolicy } from '../services/agent-policy';
import type { AIRole } from '@shared/types';

const VALID_ROLES: AIRole[] = ['doctor', 'rehab', 'nutritionist', 'trainer'];
const SUPERVISOR_AGENT_NAMESPACE = 'supervisor-agent';

function resolveRole(role: string | undefined, fallback: string | undefined): AIRole {
  if (role && VALID_ROLES.includes(role as AIRole)) return role as AIRole;
  if (fallback && VALID_ROLES.includes(fallback as AIRole)) return fallback as AIRole;
  return 'trainer';
}

function isDebugEnabled(raw: string | undefined): boolean {
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

export const agentRuntimeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

agentRuntimeRoutes.use('*', authMiddleware);

agentRuntimeRoutes.get('/runtime-context', async (c) => {
  const userId = c.get('userId');
  const role = resolveRole(c.req.query('role'), c.env.ACTIVE_AI_ROLE);

  const userContext = await getUserContext(c.env.DB, userId);
  const contextText = buildContextForRole(role, userContext);
  const runtimePolicy = loadRuntimePolicy(c.env);

  return c.json({
    success: true,
    data: {
      role,
      role_name: ROLE_NAMES[role],
      system_prompt: SYSTEM_PROMPTS[role],
      context_text: contextText,
      writeback_mode: typeof c.env.WRITEBACK_MODE === 'string' ? c.env.WRITEBACK_MODE : 'remote',
      execution_defaults: {
        flow_mode: runtimePolicy.flowMode,
        approval_fallback: runtimePolicy.approvalFallback,
        default_execution_profile: runtimePolicy.defaultExecutionProfile,
      },
    },
  });
});

agentRuntimeRoutes.get('/debug/supervisor-probe', async (c) => {
  if (!isDebugEnabled(c.env.AGENT_DEBUG_ENABLED)) {
    return c.json({ success: false, error: 'not_found' }, 404);
  }

  const userId = (() => {
    const fromQuery = c.req.query('user_id');
    if (typeof fromQuery === 'string' && fromQuery.trim()) {
      return fromQuery.trim().slice(0, 128);
    }
    return c.get('userId');
  })();

  const now = new Date().toISOString();
  const probePath = `/agents/${SUPERVISOR_AGENT_NAMESPACE}/${encodeURIComponent(userId)}`;
  const probeRequest = new Request(`https://diag.local${probePath}`, { method: 'GET' });
  const result: {
    at: string;
    user_id: string;
    probe_path: string;
    route_agent_request: Record<string, unknown>;
    do_stub_fetch: Record<string, unknown>;
  } = {
    at: now,
    user_id: userId,
    probe_path: probePath,
    route_agent_request: {},
    do_stub_fetch: {},
  };

  try {
    const response = await routeAgentRequest(probeRequest, c.env);
    result.route_agent_request = response
      ? {
        ok: true,
        status: response.status,
        has_websocket: Boolean((response as Response & { webSocket?: WebSocket }).webSocket),
      }
      : { ok: false, null_response: true };
  } catch (error) {
    const normalized = toErrorObject(error);
    result.route_agent_request = {
      ok: false,
      error: normalized.name,
      message: normalized.message,
      stack: normalized.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }

  try {
    const id = c.env.SupervisorAgent.idFromName(userId);
    const stub = c.env.SupervisorAgent.get(id);
    const response = await stub.fetch(new Request('https://diag.local/', { method: 'GET' }));
    result.do_stub_fetch = {
      ok: true,
      status: response.status,
    };
  } catch (error) {
    const normalized = toErrorObject(error);
    result.do_stub_fetch = {
      ok: false,
      error: normalized.name,
      message: normalized.message,
      stack: normalized.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }

  const routeOk = result.route_agent_request.ok === true;
  const stubOk = result.do_stub_fetch.ok === true;
  const success = routeOk && stubOk;
  const status = success ? 200 : 500;

  return c.json({
    success,
    data: result,
  }, status);
});
