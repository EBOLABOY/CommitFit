import type { LanguageModelV3, LanguageModelV3Middleware } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Bindings } from '../types';

export type LLMProviderKind = 'workers_ai';

export interface LLMRuntimeInfo {
  provider: LLMProviderKind;
  primaryModelId: string;
  roleModelId: string;
}

function createProvider(env: Bindings) {
  if (!env.AI) {
    throw new Error('Workers AI 绑定未配置');
  }
  return createWorkersAI({ binding: env.AI });
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
          provider: 'workers_ai',
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
          provider: 'workers_ai',
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

export function getLLMProviderKind(): LLMProviderKind {
  return 'workers_ai';
}

export function getLLMRuntimeInfo(env: Bindings): LLMRuntimeInfo {
  return {
    provider: 'workers_ai',
    primaryModelId: env.LLM_MODEL,
    roleModelId: pickRoleModelName(env),
  };
}

export function getMainLLMModel(env: Bindings) {
  const runtime = getLLMRuntimeInfo(env);
  const provider = createProvider(env);
  const primary = getChatModel(provider, runtime.primaryModelId);
  if (!runtime.roleModelId || runtime.roleModelId === runtime.primaryModelId) {
    return primary;
  }

  const fallback = getChatModel(provider, runtime.roleModelId);
  return wrapLanguageModel({
    model: primary,
    middleware: createFailoverMiddleware(env, runtime.primaryModelId, runtime.roleModelId, fallback),
  });
}

export function getRoleLLMModel(env: Bindings) {
  const provider = createProvider(env);
  return getChatModel(provider, getLLMRuntimeInfo(env).roleModelId);
}

export function getLLMModel(env: Bindings) {
  return getMainLLMModel(env);
}
