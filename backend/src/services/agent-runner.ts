import type { Bindings } from '../types';
import type { AIRole } from '../../../shared/types';
import { callLLM, parseSSEContent } from './llm';
import { buildContextForRole, getUserContext, trimMessages } from './context';
import { SYSTEM_PROMPTS, MAX_HISTORY_MESSAGES } from './orchestrator';
import type { OrchestrateHistoryMessage } from './orchestrator';
import { SSEStreamWriter } from './stream-writer';

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface StreamPrimaryAgentParams {
  env: Bindings;
  role: AIRole;
  userContext: Awaited<ReturnType<typeof getUserContext>>;
  history: OrchestrateHistoryMessage[];
  message: string;
  imageDataUri: string | null;
  writer: SSEStreamWriter;
}

/**
 * Stream the primary agent's LLM response to the client via SSE passthrough.
 * Returns the accumulated full text content.
 */
export async function streamPrimaryAgent(params: StreamPrimaryAgentParams): Promise<string> {
  const { env, role, userContext, history, message, imageDataUri, writer } = params;

  const currentUserContent: string | ContentPart[] = imageDataUri
    ? [
        { type: 'image_url' as const, image_url: { url: imageDataUri } },
        { type: 'text' as const, text: message },
      ]
    : message;

  const context = buildContextForRole(role, userContext);
  const systemPrompt = SYSTEM_PROMPTS[role] + '\n\n' + context;

  const normalizedHistory = history
    .filter((item) => item.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({ role: item.role, content: item.content }));

  const messages = trimMessages(
    [
      { role: 'system' as const, content: systemPrompt },
      ...normalizedHistory,
      { role: 'user' as const, content: currentUserContent },
    ],
    {
      maxSystemTokens: 8000,
      maxHistoryTokens: 4000,
      totalTokens: 12000,
    }
  );

  const llmResponse = await callLLM({ env, messages, stream: true });
  if (!llmResponse.body) {
    throw new Error('LLM 返回了空响应流');
  }

  const reader = llmResponse.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const text = decoder.decode(value, { stream: true });
    fullContent += parseSSEContent(text);

    // Passthrough raw OpenAI SSE bytes to client
    await writer.writeRaw(value);
  }

  return fullContent;
}
