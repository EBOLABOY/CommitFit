import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Bindings } from '../types';

export function getLLMModel(env: Bindings) {
  const provider = createOpenAICompatible({
    name: 'lianlema-llm',
    baseURL: env.LLM_BASE_URL.replace(/\/$/, ''),
    headers: { Authorization: `Bearer ${env.LLM_API_KEY}` },
  });
  return provider.chatModel(env.LLM_MODEL);
}
