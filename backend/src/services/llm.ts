import type { Bindings } from '../types';
import { generateText, type ModelMessage } from 'ai';
import { getMainLLMModel } from './ai-provider';

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

interface LLMCallOptions {
  env: Bindings;
  messages: LLMMessage[];
  stream?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

type WorkersTextPart = { type: 'text'; text: string };
type WorkersImagePart = { type: 'image'; image: URL };

function toWorkersModelMessages(messages: LLMMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === 'string') {
      converted.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role !== 'user') {
      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      converted.push({ role: message.role, content: text });
      continue;
    }

    const parts: Array<WorkersTextPart | WorkersImagePart> = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part.type === 'image_url') {
        const raw = part.image_url?.url;
        if (!raw || typeof raw !== 'string') continue;
        try {
          parts.push({ type: 'image', image: new URL(raw) });
        } catch {
          // Skip malformed image URLs.
        }
      }
    }

    converted.push({
      role: 'user',
      content: parts.length > 0 ? parts : '',
    });
  }

  return converted;
}

export async function callLLM({
  env,
  messages,
  stream = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: LLMCallOptions): Promise<Response> {
  if (stream) {
    throw new Error('Workers AI 模式下不支持 callLLM 的原始流式响应，请改用 AI SDK streamText');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  try {
    const { text } = await generateText({
      model: getMainLLMModel(env),
      messages: toWorkersModelMessages(messages),
      abortSignal: controller.signal,
    });

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: text || '' } }],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('LLM 请求超时，请稍后重试（Workers AI）');
    }
    throw new Error(`Workers AI 调用失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function createSSEStream(llmResponse: Response): ReadableStream {
  const reader = llmResponse.body!.getReader();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });
}

export function parseSSEContent(sseText: string): string {
  const lines = sseText.split('\n');
  let content = '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) content += delta;
    } catch {
      // skip malformed lines
    }
  }

  return content;
}

export async function callLLMNonStream(options: LLMCallOptions): Promise<string> {
  const response = await callLLM({ ...options, stream: false });
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
