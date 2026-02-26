import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OrchestrateAutoWriteSummary } from '../../shared/types';
import { api } from '../services/api';

export type WritebackDraftStatus = 'pending' | 'committing' | 'failed';

export interface WritebackDraft {
  draft_id: string;
  tool_call_id?: string;
  summary_text: string;
  payload: Record<string, unknown>;
  context_text: string;
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
            status: 'pending',
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
            });

            if (!res.success) {
              throw new Error(res.error || '同步失败');
            }

            const data = res.data as unknown;
            if (!isPlainObject(data)) {
              throw new Error('同步返回格式错误');
            }

            const status = typeof data.status === 'string' ? data.status : '';
            if (status === 'success') {
              const summaryRaw = data.summary as unknown;
              if (!isPlainObject(summaryRaw)) {
                // 允许服务端不返回 summary（例如并发 pending -> success 的极端情况）
                set((state) => ({ ...state, drafts: state.drafts.filter((d) => d.draft_id !== draftId) }));
                return null;
              }

              const summary = summaryRaw as unknown as OrchestrateAutoWriteSummary;
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
                drafts: state.drafts.map((d) => (d.draft_id === draftId ? { ...d, status: 'pending' } : d)),
              }));
              return null;
            }

            throw new Error(typeof data.error === 'string' && data.error ? data.error : '同步失败');
          }

          set((state) => ({
            ...state,
            drafts: state.drafts.map((d) => (d.draft_id === draftId ? { ...d, status: 'pending' } : d)),
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
            if (draft.status === 'pending' || draft.status === 'failed') {
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
    }
  )
);
