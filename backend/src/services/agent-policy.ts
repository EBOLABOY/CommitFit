import type { Bindings } from '../types';

export type AgentFlowMode = 'dual' | 'governed';
export type AgentApprovalFallback = 'auto_approve' | 'reject';
export type AgentExecutionProfile = 'plan' | 'build';

export interface RuntimePolicy {
  flowMode: AgentFlowMode;
  approvalFallback: AgentApprovalFallback;
  defaultExecutionProfile: AgentExecutionProfile;
}

export interface ExecutionDecision {
  requestedExecutionProfile: AgentExecutionProfile;
  effectiveExecutionProfile: AgentExecutionProfile;
  requestedAllowProfileSync: boolean;
  effectiveAllowProfileSync: boolean;
  readonlyEnforced: boolean;
  shadowReadonlyWouldApply: boolean;
}

const FLOW_MODE_SET = new Set<AgentFlowMode>(['dual', 'governed']);
const APPROVAL_FALLBACK_SET = new Set<AgentApprovalFallback>(['auto_approve', 'reject']);
const EXECUTION_PROFILE_SET = new Set<AgentExecutionProfile>(['build', 'plan']);

function normalizeFlowMode(value: unknown): AgentFlowMode {
  if (typeof value !== 'string') return 'governed';
  const v = value.trim().toLowerCase();
  return FLOW_MODE_SET.has(v as AgentFlowMode) ? (v as AgentFlowMode) : 'governed';
}

function normalizeApprovalFallback(value: unknown): AgentApprovalFallback {
  if (typeof value !== 'string') return 'auto_approve';
  const v = value.trim().toLowerCase();
  return APPROVAL_FALLBACK_SET.has(v as AgentApprovalFallback) ? (v as AgentApprovalFallback) : 'auto_approve';
}

function normalizeExecutionProfile(value: unknown): AgentExecutionProfile {
  if (typeof value !== 'string') return 'build';
  const v = value.trim().toLowerCase();
  return EXECUTION_PROFILE_SET.has(v as AgentExecutionProfile) ? (v as AgentExecutionProfile) : 'build';
}

export function loadRuntimePolicy(env: Bindings): RuntimePolicy {
  return {
    flowMode: normalizeFlowMode(env.AGENT_FLOW_MODE),
    approvalFallback: normalizeApprovalFallback(env.AGENT_APPROVAL_FALLBACK),
    defaultExecutionProfile: normalizeExecutionProfile(env.AGENT_EXECUTION_PROFILE_DEFAULT),
  };
}

export function decideExecutionProfile(raw: unknown, policy: RuntimePolicy): AgentExecutionProfile {
  if (typeof raw !== 'string' || !raw.trim()) {
    return policy.defaultExecutionProfile;
  }
  return normalizeExecutionProfile(raw);
}

export function decideExecutionBehavior(
  body: Record<string, unknown>,
  policy: RuntimePolicy
): ExecutionDecision {
  const requestedExecutionProfile = decideExecutionProfile(body.execution_profile, policy);
  const requestedAllowProfileSync = body.allow_profile_sync !== false;

  if (policy.flowMode === 'dual') {
    return {
      requestedExecutionProfile,
      effectiveExecutionProfile: 'build',
      requestedAllowProfileSync,
      effectiveAllowProfileSync: requestedAllowProfileSync,
      readonlyEnforced: false,
      shadowReadonlyWouldApply: requestedExecutionProfile === 'plan',
    };
  }

  const readonlyEnforced = requestedExecutionProfile === 'plan';
  return {
    requestedExecutionProfile,
    effectiveExecutionProfile: requestedExecutionProfile,
    requestedAllowProfileSync,
    effectiveAllowProfileSync: readonlyEnforced ? false : requestedAllowProfileSync,
    readonlyEnforced,
    shadowReadonlyWouldApply: false,
  };
}
