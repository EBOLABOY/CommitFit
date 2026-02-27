import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3, LanguageModelV3Middleware } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Bindings } from '../types';

export type LLMProviderKind = 'openai_compat' | 'workers_ai';

export interface LLMRuntimeInfo {
  provider: LLMProviderKind;
  primaryModelId: string;
  roleModelId: string;
}

function resolveLLMProvider(env: Bindings): LLMProviderKind {
  const raw = typeof env.LLM_PROVIDER === 'string' ? env.LLM_PROVIDER.trim().toLowerCase() : '';
  return raw === 'workers_ai' ? 'workers_ai' : 'openai_compat';
}

function createOpenAIProvider(env: Bindings) {
  return createOpenAICompatible({
    name: 'lianlema-llm',
    baseURL: env.LLM_BASE_URL.replace(/\/$/, ''),
    headers: { Authorization: `Bearer ${env.LLM_API_KEY}` },
  });
}

function createWorkersAIProvider(env: Bindings) {
  if (!env.AI) {
    throw new Error('LLM_PROVIDER=workers_ai 但 AI 绑定未配置');
  }
  return createWorkersAI({ binding: env.AI });
}

type LLMProvider = ReturnType<typeof createOpenAIProvider> | ReturnType<typeof createWorkersAIProvider>;

function createProvider(env: Bindings): LLMProvider {
  const providerKind = resolveLLMProvider(env);
  if (providerKind === 'workers_ai') return createWorkersAIProvider(env);
  return createOpenAIProvider(env);
}

function getChatModel(provider: LLMProvider, modelId: string): LanguageModelV3 {
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

  throw new Error(`当前 Provider 无法创建聊天模型: ${modelId}`);
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
  return msg.includes('no available channel') || msg.includes('no available channels');
}

function getFailoverProviderLabel(provider: LLMProviderKind): string {
  return provider === 'workers_ai' ? 'workers_ai' : 'openai_compat';
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
          provider: getFailoverProviderLabel(provider),
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
          provider: getFailoverProviderLabel(provider),
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

export function getLLMProviderKind(env: Bindings): LLMProviderKind {
  return resolveLLMProvider(env);
}

export function getLLMRuntimeInfo(env: Bindings): LLMRuntimeInfo {
  return {
    provider: resolveLLMProvider(env),
    primaryModelId: env.LLM_MODEL,
    roleModelId: pickRoleModelName(env),
  };
}

export function getMainLLMModel(env: Bindings) {
  const runtime = getLLMRuntimeInfo(env);
  const provider = createProvider(env);
  const primaryId = runtime.primaryModelId;
  const fallbackId = runtime.roleModelId;

  const primary = getChatModel(provider, primaryId);
  if (!fallbackId || fallbackId === primaryId) return primary;

  const fallback = getChatModel(provider, fallbackId);
  return wrapLanguageModel({
    model: primary,
    middleware: createFailoverMiddleware(env, runtime.provider, primaryId, fallbackId, fallback),
  });
}

export function getRoleLLMModel(env: Bindings) {
  const runtime = getLLMRuntimeInfo(env);
  const provider = createProvider(env);
  return getChatModel(provider, runtime.roleModelId);
}

export function getLLMModel(env: Bindings) {
  return getMainLLMModel(env);
}
