import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { buildContextForRole, getUserContext } from '../services/context';
import { ROLE_NAMES, SYSTEM_PROMPTS } from '../services/orchestrator';
import { loadRuntimePolicy } from '../services/agent-policy';
import type { AIRole } from '@shared/types';

const VALID_ROLES: AIRole[] = ['doctor', 'rehab', 'nutritionist', 'trainer'];

function resolveRole(role: string | undefined, fallback: string | undefined): AIRole {
  if (role && VALID_ROLES.includes(role as AIRole)) return role as AIRole;
  if (fallback && VALID_ROLES.includes(fallback as AIRole)) return fallback as AIRole;
  return 'trainer';
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
