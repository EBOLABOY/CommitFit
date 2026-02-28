import type { LanguageModelV3, LanguageModelV3Middleware } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Bindings } from '../types';

export type LLMProviderKind = 'workers_ai' | 'openai' | 'anthropic';

export interface LLMRuntimeInfo {
  provider: LLMProviderKind;
  primaryModelId: string;
  roleModelId: string;
}

function parseProviderKind(raw: string | undefined): LLMProviderKind {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'workers_ai' || value === 'workers') return 'workers_ai';
  if (value === 'openai') return 'openai';
  if (value === 'anthropic') return 'anthropic';
  throw new Error(`Unsupported LLM_PROVIDER: ${raw}`);
}

function resolveProviderKind(env: Bindings): LLMProviderKind {
  return parseProviderKind(env.LLM_PROVIDER);
}

function requireSecret(name: string, value: string | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${name} is required for the configured LLM provider`);
  }
  return normalized;
}

function createProvider(env: Bindings, provider: LLMProviderKind) {
  if (provider === 'workers_ai') {
    if (!env.AI) {
      throw new Error('Workers AI binding is not configured');
    }
    return createWorkersAI({ binding: env.AI });
  }

  if (provider === 'openai') {
    const apiKey = requireSecret('OPENAI_API_KEY', env.OPENAI_API_KEY);
    const baseURL = typeof env.OPENAI_BASE_URL === 'string' ? env.OPENAI_BASE_URL.trim() : '';
    return createOpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
  }

  const apiKey = requireSecret('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
  const baseURL = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '';
  return createAnthropic(baseURL ? { apiKey, baseURL } : { apiKey });
}

function getChatModel(provider: ReturnType<typeof createProvider>, modelId: string): LanguageModelV3 {
  const withMethods = provider as unknown as {
    chatModel?: (id: string) => unknown;
    chat?: (id: string) => unknown;
  };

  if (typeof provider === 'function') {
    return provider(modelId) as unknown as LanguageModelV3;
  }
  if (typeof withMethods.chatModel === 'function') {
    return withMethods.chatModel(modelId) as unknown as LanguageModelV3;
  }
  if (typeof withMethods.chat === 'function') {
    return withMethods.chat(modelId) as unknown as LanguageModelV3;
  }

  throw new Error(`Current provider cannot create a chat model: ${modelId}`);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function shouldFailoverForError(error: unknown): boolean {
  const msg = toErrorMessage(error).toLowerCase();
  return (
    msg.includes('no available channel')
    || msg.includes('no available channels')
    || msg.includes('rate limit')
    || msg.includes('429')
    || msg.includes('502')
    || msg.includes('503')
    || msg.includes('504')
    || msg.includes('temporarily unavailable')
    || msg.includes('overloaded')
    || msg.includes('timeout')
    || msg.includes('timed out')
  );
}

async function recordFailoverLog(env: Bindings, payload: Record<string, unknown>): Promise<void> {
  try {
    const key = `log:llm-failover:${Date.now()}:${crypto.randomUUID()}`;
    await env.KV.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 7 });
  } catch {
    // ignore logging failure
  }
}

function createFailoverMiddleware(
  env: Bindings,
  provider: LLMProviderKind,
  primaryModelId: string,
  fallbackModelId: string,
  fallbackModel: LanguageModelV3,
): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (!shouldFailoverForError(error)) throw error;
        await recordFailoverLog(env, {
          at: new Date().toISOString(),
          provider,
          mode: 'generate',
          primary_model: primaryModelId,
          fallback_model: fallbackModelId,
          error: toErrorMessage(error),
        });
        return await fallbackModel.doGenerate(params);
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (error) {
        if (!shouldFailoverForError(error)) throw error;
        await recordFailoverLog(env, {
          at: new Date().toISOString(),
          provider,
          mode: 'stream',
          primary_model: primaryModelId,
          fallback_model: fallbackModelId,
          error: toErrorMessage(error),
        });
        return await fallbackModel.doStream(params);
      }
    },
  };
}

function pickRoleModelName(env: Bindings): string {
  const explicit = typeof env.ROLE_LLM_MODEL === 'string' ? env.ROLE_LLM_MODEL.trim() : '';
  if (explicit) return explicit;
  const fallback = (env.LLM_FALLBACK_MODELS ?? '')
    .split(',')
    .map((name) => name.trim())
    .find(Boolean);
  if (fallback) return fallback;
  return env.LLM_MODEL;
}

export function getLLMProviderKind(env?: Bindings): LLMProviderKind {
  if (!env) return 'workers_ai';
  return resolveProviderKind(env);
}

export function getLLMRuntimeInfo(env: Bindings): LLMRuntimeInfo {
  return {
    provider: resolveProviderKind(env),
    primaryModelId: env.LLM_MODEL,
    roleModelId: pickRoleModelName(env),
  };
}

export function getMainLLMModel(env: Bindings) {
  const runtime = getLLMRuntimeInfo(env);
  const provider = createProvider(env, runtime.provider);
  const primary = getChatModel(provider, runtime.primaryModelId);
  if (!runtime.roleModelId || runtime.roleModelId === runtime.primaryModelId) {
    return primary;
  }

  const fallback = getChatModel(provider, runtime.roleModelId);
  return wrapLanguageModel({
    model: primary,
    middleware: createFailoverMiddleware(env, runtime.provider, runtime.primaryModelId, runtime.roleModelId, fallback),
  });
}

export function getRoleLLMModel(env: Bindings) {
  const runtime = getLLMRuntimeInfo(env);
  const provider = createProvider(env, runtime.provider);
  return getChatModel(provider, runtime.roleModelId);
}

export function getLLMModel(env: Bindings) {
  return getMainLLMModel(env);
}
