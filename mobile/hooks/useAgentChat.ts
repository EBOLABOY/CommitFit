import { useEffect, useRef, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getToken } from '../services/api';
import { API_BASE_URL, SUPERVISOR_AGENT_NAMESPACE } from '../constants';
import { useWritebackOutboxStore } from '../stores/writeback-outbox';
import type {
  AIRole,
  AgentApprovalFallback,
  AgentExecutionProfile,
  AgentFlowMode,
  AgentLifecycleState,
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

type IncomingUIMessage = {
  id: string;
  role: string;
  parts?: Array<{ type: string; text?: string }>;
  content?: unknown;
};

type SendMessageOptions = {
  allowProfileSync?: boolean;
  appendUserMessage?: boolean;
  userMessageId?: string;
  executionProfile?: AgentExecutionProfile;
};

type LastSentMessage = {
  text: string;
  imageDataUri?: string;
  allowProfileSync: boolean;
  executionProfile: AgentExecutionProfile;
  userMessageId: string;
};

type PersistedChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: string;
  primaryRole?: AIRole;
  supplements?: SSESupplementEvent[];
  routingInfo?: SSERoutingEvent;
};

type PersistedChatHistory = {
  v: number;
  userId: string;
  sessionId: string;
  savedAt: number;
  messages: PersistedChatMessage[];
};

export interface PolicySnapshot {
  flow_mode: AgentFlowMode;
  approval_fallback: AgentApprovalFallback;
  default_execution_profile: AgentExecutionProfile;
  requested_execution_profile: AgentExecutionProfile;
  effective_execution_profile: AgentExecutionProfile;
  requested_allow_profile_sync: boolean;
  effective_allow_profile_sync: boolean;
  writeback_mode: string;
  readonly_enforced: boolean;
  llm_provider?: string;
  llm_model?: string;
  llm_role_model?: string;
  shadow_readonly_would_apply?: boolean;
}

const CHAT_HISTORY_VERSION = 1;
const MAX_LOCAL_HISTORY_MESSAGES = 500;
const PERSIST_DEBOUNCE_MS = 450;

function makeChatHistoryKey(userId: string, sessionId: string): string {
  return `lianlema-chat-history:v${CHAT_HISTORY_VERSION}:${userId}:${sessionId}`;
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const WRITEBACK_TOOL_NAMES = new Set<string>([
  // 当前后端（按模块拆分写回工具）
  'user_patch',
  'profile_patch',
  'conditions_upsert',
  'conditions_replace_all',
  'conditions_delete',
  'conditions_clear_all',
  'training_goals_upsert',
  'training_goals_replace_all',
  'training_goals_delete',
  'training_goals_clear_all',
  'health_metrics_create',
  'health_metrics_update',
  'health_metrics_delete',
  'training_plan_set',
  'training_plan_delete',
  'nutrition_plan_set',
  'nutrition_plan_delete',
  'supplement_plan_set',
  'supplement_plan_delete',
  'diet_records_create',
  'diet_records_delete',
  'daily_log_upsert',
  'daily_log_delete',
]);

function extractErrorText(value: unknown): string {
  if (!value || typeof value !== 'object') return '服务端返回错误';
  const obj = value as Record<string, unknown>;
  if (typeof obj.errorText === 'string' && obj.errorText.trim()) return obj.errorText;
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
  if (typeof obj.body === 'string' && obj.body.trim()) return obj.body;
  return '服务端返回错误';
}

function normalizeStreamErrorText(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '请求失败，请重试';

  const lower = text.toLowerCase();

  // Provider-level channel exhaustion (upstream load balancer)
  if (lower.includes('no available channel')) return '服务繁忙，请稍后重试';

  // Retry wrapper error from AI SDK, keep only root cause if possible
  if (lower.startsWith('failed after') && lower.includes('last error:')) {
    const m = text.match(/last\\s+error:\\s*(.+)$/i);
    if (m?.[1]) return normalizeStreamErrorText(m[1]);
    return '服务暂时不可用，请稍后重试';
  }

  if (lower.includes('timeout') || lower.includes('timed out')) return '请求超时，请重试';
  if (lower.includes('tool result is missing')) return '会话恢复失败，请重试';

  // Keep it short for UI banner.
  if (text.length > 180) return `${text.slice(0, 180)}...`;
  return text;
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

function extractMessageImage(message: IncomingUIMessage): string | undefined {
  // UIMessage parts may include { type: "file", url: "..." } for images.
  if (!Array.isArray(message.parts)) return undefined;
  for (const part of message.parts as Array<Record<string, unknown>>) {
    if (part?.type !== 'file') continue;
    const url = part.url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return undefined;
}

function toChatMessage(message: IncomingUIMessage): ChatMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const converted: ChatMessage = {
    id: message.id,
    role: message.role as 'user' | 'assistant',
    content: extractMessageText(message),
    image: extractMessageImage(message),
  };

  // 过滤无内容的 assistant 记录（常见于仅含工具过程的中间消息），避免空白气泡污染会话。
  if (converted.role === 'assistant' && !converted.image && converted.content.trim().length === 0) {
    return null;
  }

  return converted;
}

// --- Hook ---

export function useAgentChat(sessionId = 'default') {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lifecycleState, setLifecycleState] = useState<AgentLifecycleState>('idle');
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState('');
  const [routingInfo, setRoutingInfo] = useState<SSERoutingEvent | null>(null);
  const [supplements, setSupplements] = useState<SSESupplementEvent[]>([]);
  const [writebackSummary, setWritebackSummary] = useState<OrchestrateAutoWriteSummary | null>(null);
  const [policySnapshot, setPolicySnapshot] = useState<PolicySnapshot | null>(null);

  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Local-First：写回工具不直接写远端，而是产出草稿写入 Outbox，再通过 HTTP commit 幂等提交
  const enqueueWritebackDraft = useWritebackOutboxStore((s) => s.enqueueDraft);
  const commitWritebackDraft = useWritebackOutboxStore((s) => s.commitDraft);

  const toolCallInfoRef = useRef<Map<string, { toolName: string; input: Record<string, unknown> }>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userIdRef = useRef<string | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const routingInfoRef = useRef<SSERoutingEvent | null>(null);
  const supplementsRef = useRef<SSESupplementEvent[]>([]);
  const lastWritebackCommitAtRef = useRef<number>(0);
  const lastSentRef = useRef<LastSentMessage | null>(null);
  const retryOnNextOpenRef = useRef(false);
  const retryLastMessageInternalRef = useRef<(() => void) | null>(null);
  const lifecycleStateRef = useRef<AgentLifecycleState>('idle');
  const policySnapshotRef = useRef<PolicySnapshot | null>(null);

  // Chat history: local-first cache (AsyncStorage) + remote DO sync.
  const localHistoryKeyRef = useRef<string | null>(null);
  const hasHydratedLocalHistoryRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateLifecycleState = useCallback((next: AgentLifecycleState) => {
    lifecycleStateRef.current = next;
    setLifecycleState(next);
    const loading = next !== 'idle' && next !== 'done' && next !== 'error';
    setIsLoading(loading);
  }, []);

  useEffect(() => {
    policySnapshotRef.current = policySnapshot;
  }, [policySnapshot]);

  // --- Local history hydrate/persist ---

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const token = await getToken();
      if (!token) {
        hasHydratedLocalHistoryRef.current = true;
        return;
      }

      const payload = decodeJwtPayload(token);
      if (!payload) {
        hasHydratedLocalHistoryRef.current = true;
        return;
      }

      const uid = payload.sub || payload.userId || payload.user_id;
      if (typeof uid !== 'string' || !uid.trim()) {
        hasHydratedLocalHistoryRef.current = true;
        return;
      }

      const userId = uid.trim();
      userIdRef.current = userId;

      const key = makeChatHistoryKey(userId, sessionId);
      localHistoryKeyRef.current = key;

      try {
        const raw = await AsyncStorage.getItem(key);
        if (cancelled) return;
        if (!raw) {
          hasHydratedLocalHistoryRef.current = true;
          return;
        }

        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }

        if (!isPlainObject(parsed)) {
          hasHydratedLocalHistoryRef.current = true;
          return;
        }

        const obj = parsed as Partial<PersistedChatHistory>;
        if (obj.v !== CHAT_HISTORY_VERSION) {
          hasHydratedLocalHistoryRef.current = true;
          return;
        }
        if (obj.userId !== userId || obj.sessionId !== sessionId) {
          hasHydratedLocalHistoryRef.current = true;
          return;
        }
        if (!Array.isArray(obj.messages)) {
          hasHydratedLocalHistoryRef.current = true;
          return;
        }

        const restored: ChatMessage[] = obj.messages
          .filter((m) =>
            isPlainObject(m)
            && typeof m.id === 'string'
            && (m.role === 'user' || m.role === 'assistant')
            && typeof m.content === 'string'
          )
          .map((m) => ({
            id: (m.id as string),
            role: (m.role as 'user' | 'assistant'),
            content: (m.content as string),
            image: typeof (m as Record<string, unknown>).image === 'string' ? ((m as Record<string, unknown>).image as string) : undefined,
            primaryRole: (m as Record<string, unknown>).primaryRole as AIRole | undefined,
            supplements: (m as Record<string, unknown>).supplements as SSESupplementEvent[] | undefined,
            routingInfo: (m as Record<string, unknown>).routingInfo as SSERoutingEvent | undefined,
            isStreaming: false,
          }))
          .slice(-MAX_LOCAL_HISTORY_MESSAGES);

        // 若远端 WS 已先恢复出消息，则不覆盖；否则用本地缓存秒开。
        if (restored.length > 0 && messagesRef.current.length === 0) {
          setMessages(restored);
        }
      } finally {
        hasHydratedLocalHistoryRef.current = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!hasHydratedLocalHistoryRef.current) return;
    const key = localHistoryKeyRef.current;
    const userId = userIdRef.current;
    if (!key || !userId) return;

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    persistTimerRef.current = setTimeout(() => {
      const snapshot = (messagesRef.current || [])
        .map((m): PersistedChatMessage => ({
          id: m.id,
          role: m.role,
          content: m.content,
          image: m.image,
          primaryRole: m.primaryRole,
          supplements: m.supplements,
          routingInfo: m.routingInfo,
        }))
        .slice(-MAX_LOCAL_HISTORY_MESSAGES);

      const payload: PersistedChatHistory = {
        v: CHAT_HISTORY_VERSION,
        userId,
        sessionId,
        savedAt: Date.now(),
        messages: snapshot,
      };

      AsyncStorage.setItem(key, JSON.stringify(payload)).catch(() => {
        // ignore persistence failures
      });
    }, PERSIST_DEBOUNCE_MS);

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [messages, sessionId]);

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
      updateLifecycleState('error');
      setError('未登录，请重新登录');
      return;
    }

    // Decode JWT to get userId (stable DO identity per user for multi-device sync)
    const payload = decodeJwtPayload(token);
    if (!payload) {
      setIsConnected(false);
      updateLifecycleState('error');
      setError('认证信息无效，请重新登录');
      return;
    }
    const uid = payload.sub || payload.userId || payload.user_id;
    if (typeof uid !== 'string' || !uid.trim()) {
      setIsConnected(false);
      updateLifecycleState('error');
      setError('认证信息无效，请重新登录');
      return;
    }
    userIdRef.current = uid.trim();

    const userId = userIdRef.current;
    if (!userId) {
      setIsConnected(false);
      updateLifecycleState('error');
      setError('认证信息无效，请重新登录');
      return;
    }
    localHistoryKeyRef.current = makeChatHistoryKey(userId, sessionId);
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
      if (lifecycleStateRef.current === 'error') {
        updateLifecycleState('idle');
      }
      try {
        ws.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
      } catch {
        // ignore resume request failure
      }
      if (retryOnNextOpenRef.current) {
        retryOnNextOpenRef.current = false;
        // Defer one tick so the hook state is settled before re-sending.
        setTimeout(() => {
          retryLastMessageInternalRef.current?.();
        }, 0);
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      wsRef.current = null;

      if (event.code === 4001) {
        // Auth failure — don't reconnect
        updateLifecycleState('error');
        setError('认证失败，请重新登录');
        return;
      }
      if (event.code === 4003) {
        updateLifecycleState('error');
        setError('会话身份校验失败，请重新登录');
        return;
      }
      if (event.code === 4008) {
        updateLifecycleState('error');
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
      updateLifecycleState('error');
      setError('WebSocket 连接失败');
    };

    ws.onmessage = (event) => {
      handleWSMessage((event as { data?: unknown }).data);
    };
  }, [sessionId, updateLifecycleState]);

  // --- Message handler ---

  const handleWSMessage = useCallback((rawData: unknown) => {
    const parsed = parseWSJSON(rawData);
    if (!parsed) return;

    const msgType = parsed.type as string;

    // --- AIChatAgent protocol: UIMessageStream chunks ---

    if (msgType === 'cf_agent_use_chat_response') {
      if (parsed.error === true) {
        updateLifecycleState('error');
        finalizeCurrentAssistant();
        setError(extractErrorText(parsed));
        return;
      }

      const done = parsed.done as boolean;

      if (done) {
        // Stream complete
        updateLifecycleState('done');
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

      // 空快照 = 远端已清空；本地也应同步清空（除非正在流式中，极端情况下由后续事件修正）。
      if (converted.length === 0) {
        setMessages([]);
        setRoutingInfo(null);
        setSupplements([]);
        routingInfoRef.current = null;
        supplementsRef.current = [];
        setStreamStatus('');
        currentAssistantIdRef.current = null;
        updateLifecycleState('idle');
        const key = localHistoryKeyRef.current;
        if (key) {
          AsyncStorage.removeItem(key).catch(() => {
            // ignore
          });
        }
        return;
      }

      setMessages((prev) => {
        const serverIds = new Set(converted.map((m) => m.id));
        const prevById = new Map(prev.map((m) => [m.id, m] as const));
        const nextIds = new Set<string>();

        // 以服务端顺序为准：先按 server snapshot 排列，再追加本地仅存在的（通常是刚发送但尚未广播的）。
        const next: ChatMessage[] = [];
        for (const sm of converted) {
          const local = prevById.get(sm.id);
          if (!local) {
            const item = { ...sm, isStreaming: false };
            next.push(item);
            nextIds.add(item.id);
            continue;
          }
          const item = {
            id: sm.id,
            role: sm.role,
            content: sm.content || local.content,
            image: sm.image || local.image,
            isStreaming: false,
            primaryRole: local.primaryRole,
            supplements: local.supplements,
            routingInfo: local.routingInfo,
          };
          next.push(item);
          nextIds.add(item.id);
        }

        const streamingId = currentAssistantIdRef.current;
        const pendingUserId = lastSentRef.current?.userMessageId || null;

        for (const m of prev) {
          if (serverIds.has(m.id) || nextIds.has(m.id)) continue;
          const keepStreamingAssistant = Boolean(
            streamingId && m.role === 'assistant' && m.id === streamingId && m.isStreaming
          );
          const keepPendingUser = Boolean(
            pendingUserId && m.role === 'user' && m.id === pendingUserId
          );
          if (keepStreamingAssistant || keepPendingUser) {
            next.push(m);
            nextIds.add(m.id);
          }
        }

        return next;
      });
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

        if (converted.role === 'assistant') {
          // 在流式过程中优先归并到“本轮最后一个 assistant”，避免把同一请求拆成多条近义气泡。
          const inFlight = lifecycleStateRef.current !== 'idle'
            && lifecycleStateRef.current !== 'done'
            && lifecycleStateRef.current !== 'error';
          if (inFlight) {
            for (let i = prev.length - 1; i >= 0; i -= 1) {
              if (prev[i].role !== 'assistant') continue;
              const next = [...prev];
              const existing = next[i];
              next[i] = {
                ...existing,
                ...converted,
                content: converted.content || existing.content,
              };
              currentAssistantIdRef.current = next[i].id;
              return next;
            }
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

    if (msgType === 'policy_snapshot') {
      const snapshot: PolicySnapshot = {
        flow_mode: (parsed.flow_mode as AgentFlowMode) || 'governed',
        approval_fallback: (parsed.approval_fallback as AgentApprovalFallback) || 'auto_approve',
        default_execution_profile: (parsed.default_execution_profile as AgentExecutionProfile) || 'build',
        requested_execution_profile: (parsed.requested_execution_profile as AgentExecutionProfile) || 'build',
        effective_execution_profile: (parsed.effective_execution_profile as AgentExecutionProfile) || 'build',
        requested_allow_profile_sync: parsed.requested_allow_profile_sync !== false,
        effective_allow_profile_sync: parsed.effective_allow_profile_sync !== false,
        writeback_mode: typeof parsed.writeback_mode === 'string' ? parsed.writeback_mode : 'remote',
        readonly_enforced: parsed.readonly_enforced === true,
        llm_provider: typeof parsed.llm_provider === 'string' ? parsed.llm_provider : undefined,
        llm_model: typeof parsed.llm_model === 'string' ? parsed.llm_model : undefined,
        llm_role_model: typeof parsed.llm_role_model === 'string' ? parsed.llm_role_model : undefined,
        shadow_readonly_would_apply: parsed.shadow_readonly_would_apply === true,
      };
      setPolicySnapshot(snapshot);
      return;
    }

    if (msgType === 'lifecycle_state') {
      const state = parsed.state as AgentLifecycleState | undefined;
      if (state) {
        updateLifecycleState(state);
      }
      return;
    }

    if (msgType === 'profile_sync_result') {
      lastWritebackCommitAtRef.current = Date.now();
      setError(null);
      setWritebackSummary(parsed.summary as OrchestrateAutoWriteSummary);
      updateLifecycleState('done');
      return;
    }

    if (msgType === 'error') {
      const errText = extractErrorText(parsed);
      updateLifecycleState('error');
      setError(errText);
    }
  }, [updateLifecycleState]);

  // --- UIMessageStream chunk handler ---

  const handleUIMessageChunk = useCallback((chunk: Record<string, unknown>) => {
    const chunkType = chunk.type as string;

    switch (chunkType) {
      case 'text-delta': {
        // Append text delta to current assistant message
        if (lifecycleStateRef.current !== 'streaming') {
          updateLifecycleState('streaming');
        }
        const text = (chunk.delta as string) || (chunk.text as string);
        if (text) {
          appendToCurrentAssistant(text);
        }
        break;
      }
      case 'text-start': {
        // A new text part started — ensure we have an assistant placeholder
        updateLifecycleState('streaming');
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
      case 'tool-input-available': {
        updateLifecycleState('tool_running');
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : '';
        if (!toolCallId || !toolName) break;
        const input = isPlainObject(chunk.input) ? chunk.input : {};
        toolCallInfoRef.current.set(toolCallId, { toolName, input });
        break;
      }
      case 'tool-input-error': {
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : '';
        if (!toolCallId || !toolName) break;
        const input = isPlainObject(chunk.input) ? chunk.input : {};
        toolCallInfoRef.current.set(toolCallId, { toolName, input });
        break;
      }
      case 'tool-approval-request': {
        // 按策略自动决策审批，避免阻塞主流程。
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        if (!toolCallId) break;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) break;
        const approvalFallback = policySnapshotRef.current?.approval_fallback || 'auto_approve';
        const approved = approvalFallback !== 'reject';
        ws.send(JSON.stringify({
          type: 'cf_agent_tool_approval',
          toolCallId,
          approved,
          autoContinue: true,
        }));
        if (!approved) {
          updateLifecycleState('error');
          setError('当前策略拒绝高风险工具操作');
        }
        break;
      }
      case 'tool-output-available': {
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        if (!toolCallId) break;

        const meta = toolCallInfoRef.current.get(toolCallId);
        const toolName = meta?.toolName || '';
        const output = chunk.output;
        const preliminary = chunk.preliminary === true;

        if (toolName === 'delegate_generate') {
          // Delegate streaming: backend yields { kind, delta } as preliminary outputs,
          // and yields { success, kind, role, plan_date, content } as final output.
          if (isPlainObject(output)) {
            if (output.success === false) {
              setError(typeof output.error === 'string' ? output.error : '委托生成失败');
            } else if (typeof output.delta === 'string' && output.delta) {
              // Ensure we have an assistant placeholder even if the model called the tool before any text-start.
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
              appendToCurrentAssistant(output.delta);
            } else if (!preliminary && typeof output.content === 'string' && output.content.trim()) {
              // Fallback: if no deltas were delivered, show the final content once.
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
              // Avoid duplicating if the stream already appended deltas.
              // Only fill when current content is empty.
              const assistantId = currentAssistantIdRef.current;
              if (assistantId) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId && !m.content ? { ...m, content: output.content as string } : m
                  )
                );
              }
            }
          }
        }

        if (WRITEBACK_TOOL_NAMES.has(toolName)) {
          if (preliminary) break;
          updateLifecycleState('writeback_queued');
          if (isPlainObject(output)) {
            // Local-First output: { success, draft_id, payload, context_text, summary_text }
            if (output.success === false) {
              setError(typeof output.error === 'string' ? output.error : '写回草稿生成失败');
              updateLifecycleState('error');
            } else if (typeof output.draft_id === 'string' && output.draft_id.trim()) {
              const draftId = output.draft_id.trim();
              const summaryText =
                (typeof output.summary_text === 'string' && output.summary_text.trim())
                  ? output.summary_text
                  : (typeof meta?.input?.summary_text === 'string' ? meta?.input?.summary_text : '已生成同步草稿');
              const payload = isPlainObject(output.payload) ? output.payload : {};
              const contextText = typeof output.context_text === 'string' ? output.context_text : '';

              enqueueWritebackDraft({
                draft_id: draftId,
                tool_call_id: toolCallId,
                summary_text: summaryText,
                payload,
                context_text: contextText,
              });

              void commitWritebackDraft(draftId).then((summary) => {
                updateLifecycleState('writeback_committing');
                if (summary) {
                  lastWritebackCommitAtRef.current = Date.now();
                  setError(null);
                  setWritebackSummary(summary);
                  updateLifecycleState('done');
                }
              });
            } else if (isPlainObject(output.changes)) {
              // remote writeback mode: tool 返回 changes
              lastWritebackCommitAtRef.current = Date.now();
              setError(null);
              setWritebackSummary(output.changes as unknown as OrchestrateAutoWriteSummary);
              updateLifecycleState('done');
            }
          }
        }

        if (!preliminary) {
          toolCallInfoRef.current.delete(toolCallId);
        }
        break;
      }
      case 'tool-output-error':
      case 'tool-output-denied': {
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        if (toolCallId) toolCallInfoRef.current.delete(toolCallId);
        break;
      }
      case 'error': {
        // Stream error
        updateLifecycleState('error');
        finalizeCurrentAssistant();
        const rawErrorText =
          (chunk.errorText as string) ||
          (chunk.error as string) ||
          (chunk.message as string) ||
          '流式响应错误';
        const errorText = normalizeStreamErrorText(rawErrorText);
        const now = Date.now();
        // 若刚完成写回提交（Local-First commit 成功），则忽略上游生成失败的噪声错误。
        if (now - lastWritebackCommitAtRef.current < 5000) {
          setError(null);
        } else {
          setError(errorText);
        }
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
        // source-url, file, etc.
        break;
    }
  }, [enqueueWritebackDraft, commitWritebackDraft, updateLifecycleState]);

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

  const sendMessageInternal = useCallback((text: string, imageDataUri: string | undefined, options: SendMessageOptions) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('未连接，请稍后重试');
      return false;
    }

    if (!text.trim()) return false;

    const allowProfileSync = options.allowProfileSync ?? true;
    const executionProfile = options.executionProfile ?? 'build';
    const now = Date.now();
    const userMessageId = (options.userMessageId && options.userMessageId.trim()) ? options.userMessageId.trim() : `${now}-user`;
    const clientTraceId = `trace-${now}-${Math.random().toString(36).slice(2, 8)}`;

    // Reset state
    setError(null);
    setStreamStatus('');
    setRoutingInfo(null);
    setSupplements([]);
    routingInfoRef.current = null;
    supplementsRef.current = [];
    if (options.appendUserMessage !== false) {
      setWritebackSummary(null);
    }
    updateLifecycleState('sending');

    const userMessage: ChatMessage = {
      id: userMessageId,
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

    setMessages((prev) => {
      if (options.appendUserMessage === false) return [...prev, assistantPlaceholder];
      return [...prev, userMessage, assistantPlaceholder];
    });

    // Build message in UIMessage format for AIChatAgent
    const msgId = userMessageId;
    const parts: Array<Record<string, string>> = [];
    if (imageDataUri) {
      parts.push({ type: 'file', url: imageDataUri, mediaType: 'image/jpeg' });
    }
    parts.push({ type: 'text', text });

    // AIChatAgent expects: { type: "cf_agent_use_chat_request", id, init: { method: "POST", body: stringified JSON } }
    const requestId = `req-${now}-${Math.random().toString(36).slice(2, 8)}`;

    lastSentRef.current = {
      text,
      imageDataUri,
      allowProfileSync,
      executionProfile,
      userMessageId,
    };

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
          allow_profile_sync: allowProfileSync,
          execution_profile: executionProfile,
          client_trace_id: clientTraceId,
          session_id: sessionId,
        }),
      },
    }));

    return true;
  }, [sessionId, updateLifecycleState]);

  const sendMessage = useCallback((text: string, imageDataUri?: string) => {
    void sendMessageInternal(text, imageDataUri, {
      appendUserMessage: true,
      allowProfileSync: true,
      executionProfile: 'build',
    });
  }, [sendMessageInternal]);

  const retryLastMessageInternal = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      retryOnNextOpenRef.current = true;
      setError(null);
      void connect();
      return;
    }

    const last = lastSentRef.current;
    if (!last) {
      // 没有可重试的消息时，尝试恢复流（对断线恢复更友好）。
      setError(null);
      try {
        ws.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
      } catch {
        // ignore resume failure
      }
      return;
    }

    // 若刚完成写回提交，则“重试”默认只重试生成，不再重复触发写回（避免重复修改数据）。
    const now = Date.now();
    const allowProfileSync =
      writebackSummary && (now - lastWritebackCommitAtRef.current < 30_000)
        ? false
        : last.allowProfileSync;

    void sendMessageInternal(last.text, last.imageDataUri, {
      appendUserMessage: false,
      allowProfileSync,
      executionProfile: last.executionProfile,
      userMessageId: last.userMessageId,
    });
  }, [connect, sendMessageInternal, writebackSummary]);

  useEffect(() => {
    retryLastMessageInternalRef.current = retryLastMessageInternal;
  }, [retryLastMessageInternal]);

  const retryLastMessage = useCallback(() => {
    retryLastMessageInternalRef.current?.();
  }, []);

  // --- Clear messages ---

  const clearMessages = useCallback(() => {
    // Also tell the server to clear persisted messages
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cf_agent_chat_clear' }));
    }
    const key = localHistoryKeyRef.current;
    if (key) {
      AsyncStorage.removeItem(key).catch(() => {
        // ignore
      });
    }
    setMessages([]);
    setRoutingInfo(null);
    setSupplements([]);
    routingInfoRef.current = null;
    supplementsRef.current = [];
    setWritebackSummary(null);
    setPolicySnapshot(null);
    setStreamStatus('');
    setError(null);
    updateLifecycleState('idle');
  }, [updateLifecycleState]);

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
    lifecycleState,
    isLoading,
    isConnected,
    error,
    streamStatus,
    routingInfo,
    supplements,
    policySnapshot,
    writebackSummary,
    sendMessage,
    retryLastMessage,
    clearMessages,
  };
}
