import type { Bindings } from '../types';

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
  maxAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1000, 3000];
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MODEL_HINT_REGEX = /model|not[\s_-]?found|unknown[\s_-]?model|model_not_found|does not exist/i;

class RetryableLLMError extends Error {
  status?: number;
  model?: string;

  constructor(message: string, status?: number, model?: string) {
    super(message);
    this.name = 'RetryableLLMError';
    this.status = status;
    this.model = model;
  }
}

class LLMHTTPError extends Error {
  status: number;
  model: string;
  responseText: string;

  constructor(message: string, status: number, model: string, responseText: string) {
    super(message);
    this.name = 'LLMHTTPError';
    this.status = status;
    this.model = model;
    this.responseText = responseText;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  return error instanceof RetryableLLMError;
}

function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status) || status >= 500;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function resolveModelCandidates(env: Bindings): string[] {
  const candidates = [
    env.LLM_MODEL,
    ...(env.LLM_FALLBACK_MODELS ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
  ];

  const deduped = new Set<string>();
  for (const model of candidates) {
    deduped.add(model);
  }
  return [...deduped];
}

function shouldSwitchToNextModel(error: unknown): boolean {
  if (isRetryableError(error)) return true;
  if (error instanceof LLMHTTPError) {
    return (error.status === 400 || error.status === 404) && MODEL_HINT_REGEX.test(error.responseText);
  }
  return false;
}

async function callLLMOnce({
  env,
  messages,
  stream,
  timeoutMs,
  model,
}: Required<Pick<LLMCallOptions, 'env' | 'messages' | 'stream' | 'timeoutMs'>> & {
  model: string;
}): Promise<Response> {
  const url = `${normalizeBaseUrl(env.LLM_BASE_URL)}/chat/completions`;

  const body = {
    model,
    messages,
    stream,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RetryableLLMError(`LLM 请求超时，请稍后重试（模型: ${model}）`, 408, model);
    }
    throw new RetryableLLMError(`LLM 网络请求失败，请稍后重试（模型: ${model}）`, undefined, model);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    if (isRetryableHttpStatus(response.status)) {
      throw new RetryableLLMError(
        `LLM 服务暂时不可用(${response.status})，请稍后重试（模型: ${model}）`,
        response.status,
        model
      );
    }
    throw new LLMHTTPError(`LLM API error: ${response.status} - ${errorText}`, response.status, model, errorText);
  }

  return response;
}

export async function callLLM({
  env,
  messages,
  stream = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts,
}: LLMCallOptions): Promise<Response> {
  const modelCandidates = resolveModelCandidates(env);
  const boundedAttempts = Number.isInteger(maxAttempts) && (maxAttempts ?? 0) > 0
    ? Math.min(maxAttempts as number, RETRY_DELAYS_MS.length + 1)
    : RETRY_DELAYS_MS.length + 1;
  let lastError: unknown;

  for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex++) {
    const model = modelCandidates[modelIndex];

    for (let attempt = 0; attempt < boundedAttempts; attempt++) {
      try {
        return await callLLMOnce({ env, messages, stream, timeoutMs, model });
      } catch (error) {
        lastError = error;
        const hasNextModel = modelIndex < modelCandidates.length - 1;

        if (isRetryableError(error)) {
          if (attempt < boundedAttempts - 1) {
            const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
            await sleep(delay);
            continue;
          }
          break;
        }

        if (hasNextModel && shouldSwitchToNextModel(error)) {
          break;
        }

        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('LLM 调用失败');
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
    if (line.startsWith('data: ')) {
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
  }

  return content;
}

export async function callLLMNonStream(options: LLMCallOptions): Promise<string> {
  const response = await callLLM({ ...options, stream: false });
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || '';
}
