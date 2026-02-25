import type { D1Database, KVNamespace, R2Bucket } from '@cloudflare/workers-types';

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  SupervisorAgent: DurableObjectNamespace;
  LLM_MODEL: string;
  LLM_FALLBACK_MODELS?: string;
  ROLE_LLM_MODEL?: string;
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  JWT_SECRET: string;
  ALLOWED_ORIGINS?: string;
  ACTIVE_AI_ROLE?: string;
  WRITEBACK_MODE?: string; // remote / local_first
};

export type Variables = {
  userId: string;
  tokenIssuedAt: number;
};
