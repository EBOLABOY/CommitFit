import { useCallback, useMemo, useRef, useState } from 'react';
import { useWorkersAgentChat, type ChatMessage, type PolicySnapshot } from './useWorkersAgentChat';
import { useAIConfigStore } from '../stores/ai-config';
import { useAuthStore } from '../stores/auth';
import { getCustomAIKey } from '../services/ai-config-secure';
import { runDirectAgentTurn } from '../services/direct-agent-runtime';
import { useWritebackOutboxStore } from '../stores/writeback-outbox';
import type {
  AgentExecutionProfile,
  AgentLifecycleState,
  OrchestrateAutoWriteSummary,
  SSERoutingEvent,
  SSESupplementEvent,
  WritebackRequestMeta,
} from '@shared/types';

type CustomLastSentMessage = {
  text: string;
  imageDataUri?: string;
};

function isLoadingState(state: AgentLifecycleState): boolean {
  return state !== 'idle' && state !== 'done' && state !== 'error';
}

function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildWritebackRequestMeta(now: Date = new Date()): WritebackRequestMeta {
  const meta: WritebackRequestMeta = {
    client_request_at: now.toISOString(),
    client_local_date: toLocalDateString(now),
    client_utc_offset_minutes: -now.getTimezoneOffset(),
  };

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === 'string' && tz.trim()) {
      meta.client_timezone = tz.trim();
    }
  } catch {
    // ignore time zone resolution failure
  }

  return meta;
}

export function useAgentChat(sessionId = 'default') {
  const resolvedConfig = useAIConfigStore((s) => s.resolved);
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const useWorkers = resolvedConfig.effective_provider === 'workers';
  const workersChat = useWorkersAgentChat(sessionId, { enabled: useWorkers });

  const enqueueWritebackDraft = useWritebackOutboxStore((s) => s.enqueueDraft);
  const commitWritebackDraft = useWritebackOutboxStore((s) => s.commitDraft);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lifecycleState, setLifecycleState] = useState<AgentLifecycleState>('idle');
  const [isConnected, setIsConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState('');
  const [routingInfo, setRoutingInfo] = useState<SSERoutingEvent | null>(null);
  const [supplements, setSupplements] = useState<SSESupplementEvent[]>([]);
  const [policySnapshot, setPolicySnapshot] = useState<PolicySnapshot | null>(null);
  const [writebackSummary, setWritebackSummary] = useState<OrchestrateAutoWriteSummary | null>(null);

  const currentAssistantIdRef = useRef<string | null>(null);
  const lastSentRef = useRef<CustomLastSentMessage | null>(null);

  const updateLifecycleState = useCallback((state: AgentLifecycleState) => {
    setLifecycleState(state);
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    if (!text) return;
    const assistantId = currentAssistantIdRef.current;
    if (!assistantId) return;
    setMessages((prev) =>
      prev.map((item) => (item.id === assistantId ? { ...item, content: item.content + text } : item))
    );
  }, []);

  const finalizeAssistant = useCallback(() => {
    const assistantId = currentAssistantIdRef.current;
    if (!assistantId) return;
    setMessages((prev) => prev.map((item) => (item.id === assistantId ? { ...item, isStreaming: false } : item)));
    currentAssistantIdRef.current = null;
  }, []);

  const sendCustomMessage = useCallback(async (text: string, imageDataUri?: string) => {
    if (!resolvedConfig.custom_ready) {
      setError('自定义代理配置不完整，已回退 Workers AI');
      setIsConnected(false);
      updateLifecycleState('error');
      return;
    }
    if (!userId) {
      setError('未登录，请重新登录');
      updateLifecycleState('error');
      return;
    }

    const apiKey = await getCustomAIKey(userId);
    if (!apiKey) {
      setError('未检测到自定义 API Key，请在 AI 配置中补全');
      updateLifecycleState('error');
      return;
    }

    setError(null);
    setStreamStatus('');
    setSupplements([]);
    setWritebackSummary(null);

    const now = Date.now();
    const requestMeta = buildWritebackRequestMeta(new Date(now));
    const userMessageId = `${now}-user`;
    const assistantId = `${now}-assistant`;
    currentAssistantIdRef.current = assistantId;
    lastSentRef.current = { text, imageDataUri };

    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: 'user', content: text, image: imageDataUri },
      { id: assistantId, role: 'assistant', content: '', isStreaming: true },
    ]);

    updateLifecycleState('sending');
    setIsConnected(true);

    try {
      await runDirectAgentTurn(
        {
          config: resolvedConfig,
          apiKey,
          sessionId,
          history: messages,
          userText: text,
          imageDataUri,
          allowProfileSync: true,
          executionProfile: 'build' as AgentExecutionProfile,
          requestMeta,
          enqueueWritebackDraft,
          commitWritebackDraft,
        },
        {
          onLifecycleState: (state, detail) => {
            updateLifecycleState(state);
            if (detail) setStreamStatus(detail);
          },
          onStatus: (message) => setStreamStatus(message),
          onRouting: (routing) => setRoutingInfo(routing),
          onTextDelta: (delta) => {
            if (lifecycleState !== 'streaming') updateLifecycleState('streaming');
            appendAssistantText(delta);
          },
          onPolicySnapshot: (snapshot) => {
            setPolicySnapshot(snapshot);
          },
          onWritebackSummary: (summary) => {
            setWritebackSummary(summary);
          },
        }
      );

      finalizeAssistant();
      updateLifecycleState('done');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '自定义代理请求失败';
      setError(msg);
      finalizeAssistant();
      updateLifecycleState('error');
    }
  }, [appendAssistantText, commitWritebackDraft, enqueueWritebackDraft, finalizeAssistant, lifecycleState, messages, resolvedConfig, sessionId, updateLifecycleState, userId]);

  const sendMessage = useCallback((text: string, imageDataUri?: string) => {
    if (useWorkers) {
      workersChat.sendMessage(text, imageDataUri);
      return;
    }
    if (!text.trim()) return;
    void sendCustomMessage(text.trim(), imageDataUri);
  }, [sendCustomMessage, useWorkers, workersChat]);

  const retryLastMessage = useCallback(() => {
    if (useWorkers) {
      workersChat.retryLastMessage();
      return;
    }
    const last = lastSentRef.current;
    if (!last) return;
    void sendCustomMessage(last.text, last.imageDataUri);
  }, [sendCustomMessage, useWorkers, workersChat]);

  const clearMessages = useCallback(() => {
    if (useWorkers) {
      workersChat.clearMessages();
      return;
    }
    currentAssistantIdRef.current = null;
    setMessages([]);
    setLifecycleState('idle');
    setError(null);
    setStreamStatus('');
    setRoutingInfo(null);
    setSupplements([]);
    setPolicySnapshot(null);
    setWritebackSummary(null);
  }, [useWorkers, workersChat]);

  const customResult = useMemo(() => ({
    messages,
    lifecycleState,
    isLoading: isLoadingState(lifecycleState),
    isConnected: isConnected && resolvedConfig.custom_ready,
    error,
    streamStatus,
    routingInfo,
    supplements,
    policySnapshot,
    writebackSummary,
    sendMessage,
    retryLastMessage,
    clearMessages,
  }), [
    clearMessages,
    error,
    isConnected,
    lifecycleState,
    messages,
    policySnapshot,
    retryLastMessage,
    routingInfo,
    resolvedConfig.custom_ready,
    sendMessage,
    streamStatus,
    supplements,
    writebackSummary,
  ]);

  return useWorkers ? workersChat : customResult;
}

export type { ChatMessage, PolicySnapshot } from './useWorkersAgentChat';
