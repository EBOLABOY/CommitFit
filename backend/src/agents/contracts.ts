import type { AIRole, OrchestrateAutoWriteSummary } from '../../../shared/types';

export interface AgentHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProfileSyncRequest {
  user_id: string;
  message: string;
  history: AgentHistoryMessage[];
  answer: string;
}

export interface ProfileSyncResult {
  updated: boolean;
  summary: OrchestrateAutoWriteSummary | null;
  changes: Array<{ part: string; status: string }>;
  interrupt_signal: string | null;
  error: string | null;
}

// --- Broadcast event types for WebSocket custom messages ---

export interface RoutingBroadcast {
  type: 'routing';
  primary_role: AIRole;
  primary_role_name: string;
  collaborators: Array<{ role: AIRole; role_name: string }>;
  reason: string;
}

export interface SupplementBroadcast {
  type: 'supplement';
  role: AIRole;
  role_name: string;
  content: string;
}

export interface StatusBroadcast {
  type: 'status';
  message: string;
}

export interface ProfileSyncResultBroadcast {
  type: 'profile_sync_result';
  summary: OrchestrateAutoWriteSummary;
}

export type CustomBroadcast =
  | RoutingBroadcast
  | SupplementBroadcast
  | StatusBroadcast
  | ProfileSyncResultBroadcast;
