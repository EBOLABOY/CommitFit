import { API_BASE_URL, SUPERVISOR_AGENT_NAMESPACE } from '../constants';
import { api, getToken } from './api';
import { getResolvedAIConfig } from '../stores/ai-config';
import { getCustomAIKey } from './ai-config-secure';

type StreamSingleRoleOptions = {
  message: string;
  imageDataUri?: string;
  sessionId?: string;
  timeoutMs?: number;
  allowProfileSync?: boolean;
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
};

const DEFAULT_TIMEOUT_MS = 120000;

function getWSBaseURL(): string {
  if (API_BASE_URL.startsWith('https://')) {
    return API_BASE_URL.replace(/^https:\/\//, 'wss://');
  }
  if (API_BASE_URL.startsWith('http://')) {
    return API_BASE_URL.replace(/^http:\/\//, 'ws://');
  }
  return API_BASE_URL;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveUserIdFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const userId = payload.sub || payload.userId || payload.user_id;
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractErrorText(value: unknown): string {
  if (!value || typeof value !== 'object') return 'AI 服务异常';
  const obj = value as Record<string, unknown>;
  if (typeof obj.errorText === 'string' && obj.errorText.trim()) return obj.errorText;
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
  if (typeof obj.body === 'string' && obj.body.trim()) return obj.body;
  return 'AI 服务异常';
}

function parseStreamChunkBody(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (typeof body !== 'string' || body.length === 0) return null;

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallback below
  }

  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // keep trying
    }
  }

  return null;
}

function normalizeAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const obj = item as Record<string, unknown>;
      return typeof obj.text === 'string' ? obj.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function uniqueCustomModels(primary: string, fallback: string): string[] {
  const models = [primary.trim(), fallback.trim()].filter(Boolean);
  return Array.from(new Set(models));
}

async function streamSingleRoleByCustom(
  options: StreamSingleRoleOptions,
  token: string,
  userId: string,
  apiKey: string
): Promise<void> {
  const {
    message,
    imageDataUri,
    sessionId = `utility-${Date.now()}`,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onChunk,
    onDone,
    onError,
  } = options;

  const resolved = getResolvedAIConfig();
  if (!resolved.custom_ready) {
    onError(new Error('自定义代理配置不完整'));
    return;
  }

  const runtime = await api.getAgentRuntimeContext('trainer', sessionId);
  if (!runtime.success || !runtime.data) {
    onError(new Error(runtime.error || '获取运行时上下文失败'));
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  try {
    const userContent = imageDataUri
      ? [
          { type: 'image_url', image_url: { url: imageDataUri } },
          { type: 'text', text: message },
        ]
      : message;

    const modelCandidates = uniqueCustomModels(resolved.custom_primary_model, resolved.custom_fallback_model);
    const errors: string[] = [];
    let parsedObj: Record<string, unknown> | null = null;

    for (const model of modelCandidates) {
      const response = await fetch(`${resolved.custom_base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0.35,
          messages: [
            {
              role: 'system',
              content: `${runtime.data.system_prompt}\n\n${runtime.data.context_text}\n\n执行模式：build`,
            },
            { role: 'user', content: userContent },
          ],
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }

      if (response.ok && parsed && typeof parsed === 'object') {
        parsedObj = parsed as Record<string, unknown>;
        break;
      }

      const err = parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : raw;
      errors.push(`${model}: ${err || response.status}`);
    }

    if (!parsedObj) {
      onError(new Error(`自定义代理调用失败: ${errors.join(' | ') || '未知错误'}`));
      return;
    }

    const obj = parsedObj;
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const messageObj = first && typeof first.message === 'object' && first.message !== null
      ? first.message as Record<string, unknown>
      : null;

    const text = messageObj ? normalizeAssistantText(messageObj.content) : '';
    if (text) onChunk(text);
    onDone();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onError(new Error('请求超时，请稍后重试'));
      return;
    }
    onError(new Error(error instanceof Error ? error.message : '自定义代理请求失败'));
  } finally {
    clearTimeout(timer);
    void token;
    void userId;
  }
}

async function streamSingleRoleByWorkers(options: StreamSingleRoleOptions, token: string, userId: string): Promise<void> {
  const {
    message,
    imageDataUri,
    sessionId = `utility-${Date.now()}`,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowProfileSync = false,
    onChunk,
    onDone,
    onError,
  } = options;

  const utilityAgentName = `${userId}:utility`;
  const wsUrl = `${getWSBaseURL()}/agents/${SUPERVISOR_AGENT_NAMESPACE}/${encodeURIComponent(utilityAgentName)}?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(wsUrl);

  let settled = false;
  let opened = false;
  let completed = false;
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { ws.close(); } catch { /* ignore */ }
    onError(new Error('请求超时，请稍后重试'));
  }, timeoutMs);

  const closeAndCleanup = () => {
    clearTimeout(timer);
    try { ws.close(); } catch { /* ignore */ }
  };

  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    closeAndCleanup();
    onError(err);
  };

  const done = () => {
    if (settled) return;
    settled = true;
    completed = true;
    try {
      ws.send(JSON.stringify({ type: 'cf_agent_chat_clear' }));
    } catch {
      // ignore
    }
    closeAndCleanup();
    onDone();
  };

  ws.onopen = () => {
    opened = true;

    try {
      ws.send(JSON.stringify({ type: 'cf_agent_chat_clear' }));
    } catch {
      // ignore clear failure
    }

    const parts: Array<Record<string, string>> = [];
    if (imageDataUri) {
      parts.push({ type: 'file', url: imageDataUri, mediaType: 'image/jpeg' });
    }
    parts.push({ type: 'text', text: message });

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      messages: [
        {
          id: msgId,
          role: 'user',
          parts,
        },
      ],
      allow_profile_sync: allowProfileSync,
      execution_profile: 'build' as const,
      client_trace_id: requestId,
      session_id: sessionId,
    };

    try {
      ws.send(
        JSON.stringify({
          type: 'cf_agent_use_chat_request',
          id: requestId,
          init: {
            method: 'POST',
            body: JSON.stringify(body),
          },
        })
      );
    } catch {
      fail(new Error('发送请求失败'));
    }
  };

  ws.onmessage = (event) => {
    if (settled) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }

    const msgType = parsed.type;
    if (msgType === 'cf_agent_use_chat_response') {
      if (parsed.error === true) {
        fail(new Error(extractErrorText(parsed)));
        return;
      }

      if (parsed.done === true) {
        done();
        return;
      }

      const chunk = parseStreamChunkBody(parsed.body);
      if (!chunk) return;

      const chunkType = chunk.type;
      if (chunkType === 'text-delta') {
        const text = (chunk.delta as string) || (chunk.text as string);
        if (typeof text === 'string' && text.length > 0) {
          onChunk(text);
        }
        return;
      }

      if (chunkType === 'error') {
        fail(new Error(extractErrorText(chunk)));
      }
      return;
    }

    if (msgType === 'error') {
      fail(new Error(extractErrorText(parsed)));
    }
  };

  ws.onerror = () => {
    fail(new Error('WebSocket 连接失败'));
  };

  ws.onclose = (event) => {
    if (settled) return;
    if (!opened) {
      fail(new Error('WebSocket 连接失败'));
      return;
    }
    if (completed) {
      done();
      return;
    }
    if (event.code === 4001) {
      fail(new Error('认证失败，请重新登录'));
      return;
    }
    fail(new Error('连接中断，请重试'));
  };
}

export async function streamSingleRoleAgent(options: StreamSingleRoleOptions): Promise<void> {
  const token = await getToken();
  if (!token) {
    options.onError(new Error('未登录，请重新登录'));
    return;
  }

  const userId = resolveUserIdFromToken(token);
  if (!userId) {
    options.onError(new Error('无法解析用户身份，请重新登录'));
    return;
  }

  const resolved = getResolvedAIConfig();
  if (resolved.effective_provider === 'custom' && resolved.custom_ready) {
    const apiKey = await getCustomAIKey(userId);
    if (apiKey && apiKey.trim()) {
      await streamSingleRoleByCustom(options, token, userId, apiKey.trim());
      return;
    }
  }

  await streamSingleRoleByWorkers(options, token, userId);
}
