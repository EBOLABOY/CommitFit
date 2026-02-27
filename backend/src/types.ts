import type { Ai, D1Database, KVNamespace, R2Bucket } from '@cloudflare/workers-types';

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  AI?: Ai;
  SupervisorAgent: DurableObjectNamespace;
  LLM_MODEL: string;
  LLM_FALLBACK_MODELS?: string;
  ROLE_LLM_MODEL?: string;
  JWT_SECRET: string;
  ALLOWED_ORIGINS?: string;
  ACTIVE_AI_ROLE?: string;
  WRITEBACK_MODE?: string; // remote / local_first
  AGENT_FLOW_MODE?: string; // dual / governed
  AGENT_APPROVAL_FALLBACK?: string; // auto_approve / reject
  AGENT_EXECUTION_PROFILE_DEFAULT?: string; // build / plan
  AGENT_DEBUG_ENABLED?: string; // true / false
};

export type Variables = {
  userId: string;
  tokenIssuedAt: number;
};
