import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  OrchestrateAutoWriteSummary,
  WritebackCommitResponseData,
  WritebackDraftStatus,
  WritebackRequestMeta,
} from '@shared/types';
import { api } from '../services/api';

export interface WritebackDraft {
  draft_id: string;
  tool_call_id?: string;
  summary_text: string;
  payload: Record<string, unknown>;
  context_text: string;
  request_meta?: WritebackRequestMeta;
  status: WritebackDraftStatus;
  created_at: number;
  attempts: number;
  last_error?: string;
}

interface WritebackOutboxState {
  drafts: WritebackDraft[];
  isFlushing: boolean;
  lastCommitted: { draft_id: string; summary: OrchestrateAutoWriteSummary; at: number } | null;

  enqueueDraft: (draft: Omit<WritebackDraft, 'status' | 'attempts' | 'created_at'> & Partial<Pick<WritebackDraft, 'created_at'>>) => void;
  removeDraft: (draftId: string) => void;
  commitDraft: (draftId: string) => Promise<OrchestrateAutoWriteSummary | null>;
  flush: () => Promise<void>;
  clear: () => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeWritebackRequestMeta(value: unknown): WritebackRequestMeta | undefined {
  if (!isPlainObject(value)) return undefined;

  const next: WritebackRequestMeta = {};
  const clientRequestAt = value.client_request_at;
  const clientTimezone = value.client_timezone;
  const clientLocalDate = value.client_local_date;
  const clientUtcOffsetMinutes = value.client_utc_offset_minutes;

  if (typeof clientRequestAt === 'string' && clientRequestAt.trim()) {
    next.client_request_at = clientRequestAt.trim();
  }
  if (typeof clientTimezone === 'string' && clientTimezone.trim()) {
    next.client_timezone = clientTimezone.trim();
  }
  if (typeof clientLocalDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientLocalDate)) {
    next.client_local_date = clientLocalDate;
  }
  if (typeof clientUtcOffsetMinutes === 'number' && Number.isFinite(clientUtcOffsetMinutes)) {
    const rounded = Math.trunc(clientUtcOffsetMinutes);
    if (rounded >= -840 && rounded <= 840) {
      next.client_utc_offset_minutes = rounded;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

const WRITEBACK_OUTBOX_PERSIST_VERSION = 2;

function normalizeDraftStatus(status: unknown): WritebackDraftStatus {
  if (status === 'queued' || status === 'committing' || status === 'pending_remote' || status === 'failed') {
    return status;
  }
  if (status === 'pending') return 'queued';
  return 'queued';
}

export const useWritebackOutboxStore = create<WritebackOutboxState>()(
  persist(
    (set, get) => ({
      drafts: [],
      isFlushing: false,
      lastCommitted: null,

      enqueueDraft: (draft) => {
        const draftId = draft.draft_id;
        if (!draftId) return;

        set((state) => {
          if (state.drafts.some((d) => d.draft_id === draftId)) {
            return state;
          }
          const createdAt = typeof draft.created_at === 'number' ? draft.created_at : Date.now();
          const next: WritebackDraft = {
            draft_id: draftId,
            tool_call_id: draft.tool_call_id,
            summary_text: draft.summary_text || '已生成同步草稿',
            payload: isPlainObject(draft.payload) ? draft.payload : {},
            context_text: typeof draft.context_text === 'string' ? draft.context_text : '',
            request_meta: sanitizeWritebackRequestMeta(draft.request_meta),
            status: 'queued',
            attempts: 0,
            created_at: createdAt,
          };
          return { ...state, drafts: [next, ...state.drafts].slice(0, 50) };
        });
      },

      removeDraft: (draftId) => {
        set((state) => ({ ...state, drafts: state.drafts.filter((d) => d.draft_id !== draftId) }));
      },

      commitDraft: async (draftId) => {
        const current = get().drafts.find((d) => d.draft_id === draftId);
        if (!current) return null;
        if (current.status === 'committing') return null;

        set((state) => ({
          ...state,
          drafts: state.drafts.map((d) =>
            d.draft_id === draftId
              ? { ...d, status: 'committing', attempts: d.attempts + 1, last_error: undefined }
              : d
          ),
        }));

        try {
          const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
          // 202(pending) 是幂等锁常见形态：客户端应轮询重试，直到 success/failed。
          const pollDelaysMs = [600, 1000, 1600, 2600, 4200, 6800];

          for (let poll = 0; poll <= pollDelaysMs.length; poll += 1) {
            const res = await api.commitWriteback({
              draft_id: current.draft_id,
              payload: current.payload,
              context_text: current.context_text,
              request_meta: sanitizeWritebackRequestMeta(current.request_meta),
            });

            if (!res.success) {
              throw new Error(res.error || '同步失败');
            }

            const data = res.data;
            if (!data) {
              throw new Error('同步返回格式错误');
            }

            const status = data.status;
            if (status === 'success') {
              const summary = data.summary as WritebackCommitResponseData['summary'];
              if (!summary || !isPlainObject(summary)) {
                // 允许服务端不返回 summary（例如并发 pending -> success 的极端情况）
                set((state) => ({ ...state, drafts: state.drafts.filter((d) => d.draft_id !== draftId) }));
                return null;
              }

              set((state) => ({
                ...state,
                drafts: state.drafts.filter((d) => d.draft_id !== draftId),
                lastCommitted: { draft_id: draftId, summary, at: Date.now() },
              }));
              return summary;
            }

            if (status === 'pending') {
              if (poll < pollDelaysMs.length) {
                // eslint-disable-next-line no-await-in-loop
                await sleep(pollDelaysMs[poll]!);
                continue;
              }
              set((state) => ({
                ...state,
                drafts: state.drafts.map((d) => (d.draft_id === draftId ? { ...d, status: 'pending_remote' } : d)),
              }));
              return null;
            }

            throw new Error(res.error || '同步失败');
          }

          set((state) => ({
            ...state,
            drafts: state.drafts.map((d) => (d.draft_id === draftId ? { ...d, status: 'pending_remote' } : d)),
          }));
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : '同步失败';
          set((state) => ({
            ...state,
            drafts: state.drafts.map((d) =>
              d.draft_id === draftId ? { ...d, status: 'failed', last_error: message } : d
            ),
          }));
          return null;
        }
      },

      flush: async () => {
        if (get().isFlushing) return;
        set({ isFlushing: true });
        try {
          // 逐个提交，保证在弱网下可控，不做并发轰炸
          const snapshot = get().drafts;
          for (const draft of snapshot) {
            if (draft.status === 'queued' || draft.status === 'pending_remote' || draft.status === 'failed') {
              // eslint-disable-next-line no-await-in-loop
              await get().commitDraft(draft.draft_id);
            }
          }
        } finally {
          set({ isFlushing: false });
        }
      },

      clear: () => set({ drafts: [], isFlushing: false, lastCommitted: null }),
    }),
    {
      name: 'lianlema-writeback-outbox',
      storage: createJSONStorage(() => AsyncStorage),
      version: WRITEBACK_OUTBOX_PERSIST_VERSION,
      migrate: (persistedState: unknown, version: number) => {
        if (!isPlainObject(persistedState)) return persistedState as WritebackOutboxState;
        const state = persistedState as Record<string, unknown>;
        const draftsRaw = Array.isArray(state.drafts) ? state.drafts : [];
        const drafts = draftsRaw
          .filter((d) => isPlainObject(d))
          .map((d) => {
            const draft = d as Record<string, unknown>;
            return {
              ...draft,
              status: normalizeDraftStatus(draft.status),
              request_meta: sanitizeWritebackRequestMeta(draft.request_meta),
            };
          });

        if (version < 2) {
          return {
            ...state,
            drafts,
          } as WritebackOutboxState;
        }

        return {
          ...state,
          drafts,
        } as WritebackOutboxState;
      },
    }
  )
);
