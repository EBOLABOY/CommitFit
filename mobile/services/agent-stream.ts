import type { AIRole } from '../../shared/types';
import { API_BASE_URL, SUPERVISOR_AGENT_NAMESPACE } from '../constants';
import { getToken } from './api';

type StreamSingleRoleOptions = {
  role: AIRole;
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

export async function streamSingleRoleAgent(options: StreamSingleRoleOptions): Promise<void> {
  const {
    role,
    message,
    imageDataUri,
    sessionId = `utility-${Date.now()}`,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowProfileSync = false,
    onChunk,
    onDone,
    onError,
  } = options;

  const token = await getToken();
  if (!token) {
    onError(new Error('未登录，请重新登录'));
    return;
  }

  const userId = resolveUserIdFromToken(token);
  if (!userId) {
    onError(new Error('无法解析用户身份，请重新登录'));
    return;
  }

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
      preferred_role: role,
      single_role: true,
      allow_profile_sync: allowProfileSync,
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
