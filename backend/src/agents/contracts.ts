import type {
  AIRole,
  AgentApprovalFallback,
  AgentExecutionProfile,
  AgentFlowMode,
  AgentLifecycleState,
  OrchestrateAutoWriteSummary,
} from '@shared/types';

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

export interface PolicySnapshotBroadcast {
  type: 'policy_snapshot';
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

export interface LifecycleStateBroadcast {
  type: 'lifecycle_state';
  state: AgentLifecycleState;
  at: string;
  detail?: string;
  request_id?: string;
}

export interface ProfileSyncResultBroadcast {
  type: 'profile_sync_result';
  summary: OrchestrateAutoWriteSummary;
}

export type CustomBroadcast =
  | RoutingBroadcast
  | SupplementBroadcast
  | StatusBroadcast
  | PolicySnapshotBroadcast
  | LifecycleStateBroadcast
  | ProfileSyncResultBroadcast;
