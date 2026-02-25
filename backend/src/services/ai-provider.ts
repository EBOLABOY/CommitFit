import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Bindings } from '../types';

function createProvider(env: Bindings) {
  return createOpenAICompatible({
    name: 'lianlema-llm',
    baseURL: env.LLM_BASE_URL.replace(/\/$/, ''),
    headers: { Authorization: `Bearer ${env.LLM_API_KEY}` },
  });
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
  return provider.chatModel(env.LLM_MODEL);
}

export function getRoleLLMModel(env: Bindings) {
  const provider = createProvider(env);
  return provider.chatModel(pickRoleModelName(env));
}

export function getLLMModel(env: Bindings) {
  return getMainLLMModel(env);
}
