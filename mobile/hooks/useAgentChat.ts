import { useEffect, useRef, useState, useCallback } from 'react';
import { getToken } from '../services/api';
import { API_BASE_URL, SUPERVISOR_AGENT_NAMESPACE } from '../constants';
import type {
  AIRole,
  OrchestrateAutoWriteSummary,
  SSERoutingEvent,
  SSESupplementEvent,
} from '../../shared/types';

// --- Types ---

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: string;
  isStreaming?: boolean;
  primaryRole?: AIRole;
  supplements?: SSESupplementEvent[];
  routingInfo?: SSERoutingEvent;
}

export interface PendingToolApproval {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  summaryText: string;
}

type IncomingUIMessage = {
  id: string;
  role: string;
  parts?: Array<{ type: string; text?: string }>;
  content?: unknown;
};

// --- WebSocket URL ---

function getWSBaseURL(): string {
  // https -> wss, http -> ws
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

function parseWSJSON(rawData: unknown): Record<string, unknown> | null {
  if (typeof rawData === 'string') {
    try {
      const parsed = JSON.parse(rawData);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }

  if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    return rawData as Record<string, unknown>;
  }

  return null;
}

function extractErrorText(value: unknown): string {
  if (!value || typeof value !== 'object') return '服务端返回错误';
  const obj = value as Record<string, unknown>;
  if (typeof obj.errorText === 'string' && obj.errorText.trim()) return obj.errorText;
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
  if (typeof obj.body === 'string' && obj.body.trim()) return obj.body;
  return '服务端返回错误';
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

  // 兼容潜在 SSE 形态：data: {...}\n\n
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

function extractMessageText(message: IncomingUIMessage): string {
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
  }
  return typeof message.content === 'string' ? message.content : '';
}

function toChatMessage(message: IncomingUIMessage): ChatMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  return {
    id: message.id,
    role: message.role as 'user' | 'assistant',
    content: extractMessageText(message),
  };
}

// --- Hook ---

export function useAgentChat(sessionId = 'default') {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState('');
  const [routingInfo, setRoutingInfo] = useState<SSERoutingEvent | null>(null);
  const [supplements, setSupplements] = useState<SSESupplementEvent[]>([]);
  const [writebackSummary, setWritebackSummary] = useState<OrchestrateAutoWriteSummary | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingToolApproval | null>(null);

  // 幂等处理：同一个 toolCallId 可能在断线重连/流恢复时被重复推送，避免重复弹窗。
  const toolApprovalDecisionRef = useRef<Map<string, boolean>>(new Map());
  const pendingApprovalRef = useRef<PendingToolApproval | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userIdRef = useRef<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const routingInfoRef = useRef<SSERoutingEvent | null>(null);
  const supplementsRef = useRef<SSESupplementEvent[]>([]);

  useEffect(() => {
    pendingApprovalRef.current = pendingApproval;
  }, [pendingApproval]);

  // --- Connect ---

  const connect = useCallback(async () => {
    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }

    const token = await getToken();
    if (!token) {
      setError('未登录，请重新登录');
      return;
    }

    // Decode JWT to get userId (stable DO identity per user for multi-device sync)
    const payload = decodeJwtPayload(token);
    if (!payload) {
      setIsConnected(false);
      setError('认证信息无效，请重新登录');
      return;
    }
    const uid = payload.sub || payload.userId || payload.user_id;
    if (typeof uid !== 'string' || !uid.trim()) {
      setIsConnected(false);
      setError('认证信息无效，请重新登录');
      return;
    }
    userIdRef.current = uid.trim();

    const userId = userIdRef.current;
    if (!userId) {
      setIsConnected(false);
      setError('认证信息无效，请重新登录');
      return;
    }
    const wsUrl = `${getWSBaseURL()}/agents/${SUPERVISOR_AGENT_NAMESPACE}/${encodeURIComponent(userId)}?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setIsConnected(true);
      setError(null);
      try {
        ws.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
      } catch {
        // ignore resume request failure
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      wsRef.current = null;

      if (event.code === 4001) {
        // Auth failure — don't reconnect
        setError('认证失败，请重新登录');
        return;
      }
      if (event.code === 4003) {
        setError('会话身份校验失败，请重新登录');
        return;
      }
      if (event.code === 4008) {
        setError(event.reason || '连接过于频繁，请稍后重试');
        return;
      }

      // Auto-reconnect after 3s for non-auth failures
      if (!event.wasClean) {
        reconnectTimerRef.current = setTimeout(() => {
          void connect();
        }, 3000);
      }
    };

    ws.onerror = () => {
      setError('WebSocket 连接失败');
    };

    ws.onmessage = (event) => {
      handleWSMessage((event as { data?: unknown }).data);
    };
  }, [sessionId]);

  // --- Message handler ---

  const handleWSMessage = useCallback((rawData: unknown) => {
    const parsed = parseWSJSON(rawData);
    if (!parsed) return;

    const msgType = parsed.type as string;

    // --- AIChatAgent protocol: UIMessageStream chunks ---

    if (msgType === 'cf_agent_use_chat_response') {
      if (parsed.error === true) {
        setIsLoading(false);
        finalizeCurrentAssistant();
        setError(extractErrorText(parsed));
        return;
      }

      const done = parsed.done as boolean;

      if (done) {
        // Stream complete
        setIsLoading(false);
        finalizeCurrentAssistant();
        return;
      }

      // Parse the UIMessageStream chunk from body
      const chunk = parseStreamChunkBody(parsed.body);
      if (!chunk) return;

      handleUIMessageChunk(chunk);
      return;
    }

    if (msgType === 'cf_agent_stream_resuming') {
      const resumeId = typeof parsed.id === 'string' ? parsed.id : '';
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && resumeId) {
        try {
          ws.send(JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: resumeId }));
        } catch {
          // ignore ack send failure
        }
      }
      return;
    }

    // --- AIChatAgent protocol: initial messages on connect ---

    if (msgType === 'cf_agent_chat_messages') {
      // Server sends persisted messages on connect or when other clients send messages
      const serverMessages = parsed.messages as IncomingUIMessage[];
      if (!Array.isArray(serverMessages)) return;

      // Convert UIMessages to ChatMessages, merge with existing
      const converted: ChatMessage[] = serverMessages
        .map((m) => toChatMessage(m))
        .filter((m): m is ChatMessage => m !== null);

      if (converted.length > 0) {
        setMessages((prev) => {
          // Merge: add only messages that aren't already in local state
          const existingIds = new Set(prev.map((m) => m.id));
          const newMsgs = converted.filter((m) => !existingIds.has(m.id));
          return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev;
        });
      }
      return;
    }

    if (msgType === 'cf_agent_message_updated') {
      const serverMessage = parsed.message as IncomingUIMessage | undefined;
      if (!serverMessage || typeof serverMessage !== 'object') return;
      const converted = toChatMessage(serverMessage);
      if (!converted) return;

      setMessages((prev) => {
        const existingIdx = prev.findIndex((m) => m.id === converted.id);
        if (existingIdx >= 0) {
          const next = [...prev];
          const existing = next[existingIdx];
          next[existingIdx] = {
            ...existing,
            ...converted,
            content: converted.content || existing.content,
          };
          return next;
        }

        const streamingId = currentAssistantIdRef.current;
        if (converted.role === 'assistant' && streamingId) {
          const streamingIdx = prev.findIndex((m) => m.id === streamingId);
          if (streamingIdx >= 0) {
            const next = [...prev];
            const existing = next[streamingIdx];
            next[streamingIdx] = {
              ...existing,
              ...converted,
              id: converted.id,
              content: converted.content || existing.content,
            };
            currentAssistantIdRef.current = converted.id;
            return next;
          }
        }

        return [...prev, converted];
      });
      return;
    }

    // --- Custom broadcast messages (from supervisor's broadcastCustom) ---

    if (msgType === 'routing') {
      const routing: SSERoutingEvent = {
        primary_role: parsed.primary_role as AIRole,
        primary_role_name: parsed.primary_role_name as string,
        collaborators: (parsed.collaborators || []) as Array<{ role: AIRole; role_name: string }>,
        reason: (parsed.reason || '') as string,
      };
      routingInfoRef.current = routing;
      setRoutingInfo(routing);
      return;
    }

    if (msgType === 'supplement') {
      const sup: SSESupplementEvent = {
        role: parsed.role as AIRole,
        role_name: parsed.role_name as string,
        content: parsed.content as string,
      };
      setSupplements((prev) => {
        const next = [...prev, sup];
        supplementsRef.current = next;
        return next;
      });
      return;
    }

    if (msgType === 'status') {
      setStreamStatus(parsed.message as string);
      return;
    }

    if (msgType === 'profile_sync_result') {
      setWritebackSummary(parsed.summary as OrchestrateAutoWriteSummary);
      return;
    }

    if (msgType === 'error') {
      const errText = extractErrorText(parsed);
      setIsLoading(false);
      setError(errText);
    }
  }, []);

  // --- UIMessageStream chunk handler ---

  const handleUIMessageChunk = useCallback((chunk: Record<string, unknown>) => {
    const chunkType = chunk.type as string;

    switch (chunkType) {
      case 'text-delta': {
        // Append text delta to current assistant message
        const text = (chunk.delta as string) || (chunk.text as string);
        if (text) {
          appendToCurrentAssistant(text);
        }
        break;
      }
      case 'text-start': {
        // A new text part started — ensure we have an assistant placeholder
        if (!currentAssistantIdRef.current) {
          const assistantId = `stream-${Date.now()}`;
          currentAssistantIdRef.current = assistantId;
          setMessages((prev) => [...prev, {
            id: assistantId,
            role: 'assistant',
            content: '',
            isStreaming: true,
          }]);
        }
        break;
      }
      case 'text-end': {
        // Text part ended (but stream may continue with tool calls etc.)
        break;
      }
      case 'tool-approval-request': {
        // Tool needs human approval
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : '';
        if (!toolCallId || !toolName) break;

        // 若已对该 toolCallId 做出过决定（同意/拒绝），直接重发决定，避免重复弹窗。
        const decided = toolApprovalDecisionRef.current.get(toolCallId);
        if (typeof decided === 'boolean') {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({
                type: 'cf_agent_tool_approval',
                toolCallId,
                approved: decided,
                autoContinue: true,
              }));
            } catch {
              // ignore resend failure
            }
          }
          break;
        }

        // 已经在弹同一个请求时，不要重复 setState（避免 UI 反复闪烁/多次弹窗）。
        const currentPending = pendingApprovalRef.current;
        if (currentPending && currentPending.toolCallId === toolCallId) break;

        const input = (chunk.input || {}) as Record<string, unknown>;
        const summaryText = (input.summary_text as string) || '确认同步以下数据？';
        setPendingApproval({ toolCallId, toolName, args: input, summaryText });
        break;
      }
      case 'error': {
        // Stream error
        setIsLoading(false);
        const errorText =
          (chunk.errorText as string) ||
          (chunk.error as string) ||
          (chunk.message as string) ||
          '流式响应错误';
        setError(errorText);
        break;
      }
      case 'finish':
      case 'finish-step':
      case 'start':
      case 'start-step':
        // Metadata events — no UI action needed
        break;
      default:
        // tool-input-start, tool-input-delta, tool-input-end,
        // tool-output-available, tool-output-error, source, file, etc.
        break;
    }
  }, []);

  const appendToCurrentAssistant = useCallback((text: string) => {
    const assistantId = currentAssistantIdRef.current;
    if (!assistantId) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, content: m.content + text } : m
      )
    );
  }, []);

  const finalizeCurrentAssistant = useCallback(() => {
    const assistantId = currentAssistantIdRef.current;
    if (!assistantId) return;
    const finalRouting = routingInfoRef.current;
    const finalSupplements = supplementsRef.current;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              isStreaming: false,
              routingInfo: m.routingInfo ?? finalRouting ?? undefined,
              supplements: m.supplements ?? (finalSupplements.length > 0 ? finalSupplements : undefined),
            }
          : m
      )
    );
    currentAssistantIdRef.current = null;
    setStreamStatus('');
  }, []);

  // --- Send message ---

  const sendMessage = useCallback((text: string, imageDataUri?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('未连接，请稍后重试');
      return;
    }

    if (pendingApproval) {
      setError('请先确认或拒绝当前档案同步请求');
      return;
    }

    if (!text.trim()) return;

    // Reset state
    setError(null);
    setStreamStatus('');
    setRoutingInfo(null);
    setSupplements([]);
    routingInfoRef.current = null;
    supplementsRef.current = [];
    setWritebackSummary(null);
    setIsLoading(true);

    const now = Date.now();
    const userMessage: ChatMessage = {
      id: `${now}-user`,
      role: 'user',
      content: text,
      image: imageDataUri,
    };
    const assistantId = `${now}-assistant`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      isStreaming: true,
    };
    currentAssistantIdRef.current = assistantId;

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);

    // Build message in UIMessage format for AIChatAgent
    // AIChatAgent's autoTransformMessages handles both legacy and UIMessage formats
    const msgId = `msg-${now}`;
    const parts: Array<Record<string, string>> = [];
    if (imageDataUri) {
      parts.push({ type: 'file', url: imageDataUri, mediaType: 'image/jpeg' });
    }
    parts.push({ type: 'text', text });

    // AIChatAgent expects: { type: "cf_agent_use_chat_request", id, init: { method: "POST", body: stringified JSON } }
    const requestId = `req-${now}-${Math.random().toString(36).slice(2, 8)}`;
    ws.send(JSON.stringify({
      type: 'cf_agent_use_chat_request',
      id: requestId,
      init: {
        method: 'POST',
        body: JSON.stringify({
          messages: [{
            id: msgId,
            role: 'user',
            parts,
          }],
          allow_profile_sync: true,
        }),
      },
    }));
  }, [pendingApproval]);

  // --- Tool approval ---

  const approveToolCall = useCallback((toolCallId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    toolApprovalDecisionRef.current.set(toolCallId, true);
    // 防止 Map 无限增长（仅保留最近一段时间内的决定）
    if (toolApprovalDecisionRef.current.size > 200) {
      const firstKey = toolApprovalDecisionRef.current.keys().next().value as string | undefined;
      if (firstKey) toolApprovalDecisionRef.current.delete(firstKey);
    }
    ws.send(JSON.stringify({
      type: 'cf_agent_tool_approval',
      toolCallId,
      approved: true,
      autoContinue: true,
    }));
    setPendingApproval(null);
  }, []);

  const rejectToolCall = useCallback((toolCallId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    toolApprovalDecisionRef.current.set(toolCallId, false);
    if (toolApprovalDecisionRef.current.size > 200) {
      const firstKey = toolApprovalDecisionRef.current.keys().next().value as string | undefined;
      if (firstKey) toolApprovalDecisionRef.current.delete(firstKey);
    }
    ws.send(JSON.stringify({
      type: 'cf_agent_tool_approval',
      toolCallId,
      approved: false,
      autoContinue: true,
    }));
    setPendingApproval(null);
  }, []);

  // --- Clear messages ---

  const clearMessages = useCallback(() => {
    // Also tell the server to clear persisted messages
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cf_agent_chat_clear' }));
    }
    setMessages([]);
    setRoutingInfo(null);
    setSupplements([]);
    routingInfoRef.current = null;
    supplementsRef.current = [];
    setWritebackSummary(null);
    setPendingApproval(null);
    setStreamStatus('');
    setError(null);
  }, []);

  // --- Lifecycle ---

  useEffect(() => {
    void connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on unmount
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return {
    messages,
    isLoading,
    isConnected,
    error,
    streamStatus,
    routingInfo,
    supplements,
    writebackSummary,
    pendingApproval,
    sendMessage,
    approveToolCall,
    rejectToolCall,
    clearMessages,
  };
}
