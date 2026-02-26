import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3, LanguageModelV3Middleware } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import type { Bindings } from '../types';

function createProvider(env: Bindings) {
  return createOpenAICompatible({
    name: 'lianlema-llm',
    baseURL: env.LLM_BASE_URL.replace(/\/$/, ''),
    headers: { Authorization: `Bearer ${env.LLM_API_KEY}` },
  });
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

export function getMainLLMModel(env: Bindings) {
  const provider = createProvider(env);
  const primaryId = env.LLM_MODEL;
  const fallbackId = pickRoleModelName(env);

  const primary = provider.chatModel(primaryId) as unknown as LanguageModelV3;
  if (!fallbackId || fallbackId === primaryId) return primary;

  const fallback = provider.chatModel(fallbackId) as unknown as LanguageModelV3;
  return wrapLanguageModel({
    model: primary,
    middleware: createFailoverMiddleware(env, primaryId, fallbackId, fallback),
  });
}

export function getRoleLLMModel(env: Bindings) {
  const provider = createProvider(env);
  const roleId = pickRoleModelName(env);
  return provider.chatModel(roleId) as unknown as LanguageModelV3;
}

export function getLLMModel(env: Bindings) {
  return getMainLLMModel(env);
}
