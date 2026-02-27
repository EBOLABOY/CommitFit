// ============ AI Roles ============

export type AIRole = 'doctor' | 'rehab' | 'nutritionist' | 'trainer';

export const AI_ROLE_NAMES: Record<AIRole, string> = {
  doctor: '运动医生',
  rehab: '康复师',
  nutritionist: '营养师',
  trainer: '私人教练',
};

// ============ Agent Governance ============

export type AgentFlowMode = 'dual' | 'governed';
export type AgentApprovalFallback = 'auto_approve' | 'reject';
export type AgentExecutionProfile = 'plan' | 'build';
export type DirectAgentExecutionProfile = AgentExecutionProfile;
export type AgentLifecycleState =
  | 'idle'
  | 'sending'
  | 'streaming'
  | 'tool_running'
  | 'writeback_queued'
  | 'writeback_committing'
  | 'done'
  | 'error';

export type WritebackDraftStatus = 'queued' | 'committing' | 'pending_remote' | 'failed';

export type WritebackCommitStatus = 'success' | 'pending' | 'failed' | string;
export type WritebackCommitState = 'success' | 'pending_remote' | string;

export interface WritebackRequestMeta {
  client_request_at?: string;
  client_timezone?: string;
  client_local_date?: string;
  client_utc_offset_minutes?: number;
}

export interface WritebackCommitResponseData {
  draft_id: string;
  status: WritebackCommitStatus;
  state?: WritebackCommitState;
  summary?: OrchestrateAutoWriteSummary | null;
  committed?: boolean;
}

export type MobileAIProvider = 'workers' | 'custom';

export interface MobileAIConfig {
  provider: MobileAIProvider;
  custom_base_url: string;
  custom_primary_model: string;
  custom_fallback_model: string;
  custom_api_key_configured: boolean;
}

export interface MobileAIResolvedConfig {
  provider: MobileAIProvider;
  effective_provider: MobileAIProvider;
  custom_base_url: string;
  custom_primary_model: string;
  custom_fallback_model: string;
  custom_api_key_configured: boolean;
  custom_ready: boolean;
}

export interface AgentRuntimeContextResponse {
  role: AIRole;
  role_name: string;
  system_prompt: string;
  context_text: string;
  writeback_mode: string;
  execution_defaults: {
    flow_mode: AgentFlowMode;
    approval_fallback: AgentApprovalFallback;
    default_execution_profile: AgentExecutionProfile;
  };
}

// ============ Auth ============

export interface RegisterRequest {
  email: string;
  password: string;
  nickname?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    nickname: string | null;
    avatar_key: string | null;
  };
}

// ============ User Profile ============

export type Gender = 'male' | 'female';

export interface UserProfile {
  user_id: string;
  height: number | null;
  weight: number | null;
  birth_date: string | null; // YYYY-MM-DD
  gender: Gender | null;
  training_start_time: string | null; // HH:mm（24小时制）
  breakfast_time: string | null; // HH:mm（24小时制）
  lunch_time: string | null; // HH:mm（24小时制）
  dinner_time: string | null; // HH:mm（24小时制）
  training_years: number | null;
  training_goal: string | null;
  updated_at: string;
}

export interface UpdateProfileRequest {
  height?: number;
  weight?: number;
  birth_date?: string | null;
  gender?: Gender;
  training_start_time?: string | null; // HH:mm（24小时制）
  breakfast_time?: string | null; // HH:mm（24小时制）
  lunch_time?: string | null; // HH:mm（24小时制）
  dinner_time?: string | null; // HH:mm（24小时制）
  training_years?: number | null;
  training_goal?: string;
}

// ============ Health Metrics ============

export type MetricType =
  | 'testosterone'
  | 'blood_pressure'
  | 'blood_lipids'
  | 'blood_sugar'
  | 'heart_rate'
  | 'body_fat'
  | 'other';

export interface HealthMetric {
  id: string;
  user_id: string;
  metric_type: MetricType;
  value: string; // JSON string
  unit: string | null;
  recorded_at: string | null;
  created_at: string;
}

export interface CreateHealthMetricRequest {
  metric_type: MetricType;
  value: string;
  unit?: string;
  recorded_at?: string;
}

// ============ Conditions ============

export type Severity = 'mild' | 'moderate' | 'severe';
export type ConditionStatus = 'active' | 'recovered';

export interface Condition {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  severity: Severity | null;
  status: ConditionStatus;
  created_at: string;
}

export interface CreateConditionRequest {
  name: string;
  description?: string;
  severity?: Severity;
}

// ============ Training Goals ============

export type TrainingGoalStatus = 'active' | 'completed';

export interface TrainingGoal {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: TrainingGoalStatus;
  created_at: string;
}

export interface CreateTrainingGoalRequest {
  name: string;
  description?: string;
}

// ============ Training Plans ============

export interface TrainingPlan {
  id: string;
  user_id: string;
  plan_date: string;
  content: string; // JSON string
  completed: number;
  notes: string | null;
  created_at: string;
}

// ============ Nutrition Plans ============

export interface NutritionPlan {
  id: string;
  user_id: string;
  plan_date: string;
  content: string; // JSON string
  created_at: string;
}

// ============ Chat ============

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  user_id: string;
  role: AIRole;
  message_role: MessageRole;
  content: string;
  image_url: string | null;
  created_at: string;
}

export interface ChatRequest {
  role: AIRole;
  message: string;
  image?: string; // base64 data URI
}

export interface ChatHistoryResponse {
  messages: ChatMessage[];
}

export interface OrchestrateAutoWriteSummary {
  profile_updated: boolean;
  user_updated?: boolean;
  conditions_upserted: number;
  conditions_deleted?: number;
  training_goals_upserted: number;
  training_goals_deleted?: number;
  health_metrics_created: number;
  health_metrics_updated?: number;
  health_metrics_deleted?: number;
  training_plan_created: boolean;
  training_plan_deleted?: boolean;
  nutrition_plan_created: boolean;
  nutrition_plan_deleted?: boolean;
  supplement_plan_created: boolean;
  supplement_plan_deleted?: boolean;
  diet_records_created: number;
  diet_records_deleted?: number;
  daily_log_upserted: boolean;
  daily_log_deleted?: boolean;
}

// ============ SSE Events (Supervisor Multi-Agent) ============

export interface SSERoutingEvent {
  primary_role: AIRole;
  primary_role_name: string;
  collaborators: Array<{ role: AIRole; role_name: string }>;
  reason: string;
}

export interface SSESupplementEvent {
  role: AIRole;
  role_name: string;
  content: string;
}

// ============ Cloudflare Agents Event Protocol ============

export type AgentStreamEventType =
  | 'status'
  | 'primary_stream'
  | 'profile_sync'
  | 'supplementary_card'
  | 'error'
  | 'done';

export interface AgentStatusEventPayload {
  type: 'status';
  agent: string;
  data: string;
}

export interface AgentPrimaryStreamEventPayload {
  type: 'primary_stream';
  agent: string;
  data: string;
}

export interface AgentProfileSyncPayload {
  part: string;
  status: string;
  summary?: OrchestrateAutoWriteSummary | null;
  interrupt_signal?: string | null;
}

export interface AgentProfileSyncEventPayload {
  type: 'profile_sync';
  agent: string;
  data: AgentProfileSyncPayload;
}

export interface AgentSupplementaryCardPayload {
  role: AIRole;
  role_name: string;
  data: string;
}

export interface AgentSupplementaryCardEventPayload {
  type: 'supplementary_card';
  agent: string;
  data: AgentSupplementaryCardPayload;
}

export interface AgentErrorEventPayload {
  type: 'error';
  agent: string;
  data: string;
}

export interface AgentDoneEventPayload {
  type: 'done';
  agent: string;
  data: null;
}

export type AgentStreamEventPayload =
  | AgentStatusEventPayload
  | AgentPrimaryStreamEventPayload
  | AgentProfileSyncEventPayload
  | AgentSupplementaryCardEventPayload
  | AgentErrorEventPayload
  | AgentDoneEventPayload;

export interface WritebackAudit {
  id: string;
  source: 'orchestrate_stream' | 'writeback_commit' | string;
  status: 'success' | 'failed' | string;
  summary: OrchestrateAutoWriteSummary | null;
  error: string | null;
  message_excerpt: string | null;
  created_at: string;
}

// ============ WebSocket Events (AIChatAgent) ============

export interface WSRoutingEvent {
  type: 'routing';
  primary_role: AIRole;
  primary_role_name: string;
  collaborators: Array<{ role: AIRole; role_name: string }>;
  reason: string;
}

export interface WSSupplementEvent {
  type: 'supplement';
  role: AIRole;
  role_name: string;
  content: string;
}

export interface WSStatusEvent {
  type: 'status';
  message: string;
}

export interface WSPolicySnapshotEvent {
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

export interface WSLifecycleStateEvent {
  type: 'lifecycle_state';
  state: AgentLifecycleState;
  at: string;
  detail?: string;
  request_id?: string;
}

export interface WSProfileSyncResultEvent {
  type: 'profile_sync_result';
  summary: OrchestrateAutoWriteSummary;
}

export type WSCustomEvent =
  | WSRoutingEvent
  | WSSupplementEvent
  | WSStatusEvent
  | WSPolicySnapshotEvent
  | WSLifecycleStateEvent
  | WSProfileSyncResultEvent;

export interface ToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

// ============ API Response ============

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============ Diet Records ============

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface DietRecord {
  id: string;
  user_id: string;
  meal_type: MealType;
  record_date: string;
  food_description: string;
  foods_json: string | null;
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  image_key: string | null;
  created_at: string;
}

export interface FoodItem {
  name: string;
  amount: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

export interface FoodAnalysisResult {
  foods: FoodItem[];
  total: { calories: number; protein: number; fat: number; carbs: number };
}

export interface CreateDietRecordRequest {
  meal_type: MealType;
  record_date: string;
  food_description: string;
  foods_json?: string;
  calories?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
  image_key?: string;
}

// ============ Daily Logs ============

export type SleepQuality = 'good' | 'fair' | 'poor';

export interface DailyLog {
  id: string;
  user_id: string;
  log_date: string;
  weight: number | null;
  sleep_hours: number | null;
  sleep_quality: SleepQuality | null;
  note: string | null;
  created_at: string;
}

export interface UpsertDailyLogRequest {
  log_date: string;
  weight?: number | null;
  sleep_hours?: number | null;
  sleep_quality?: SleepQuality | null;
  note?: string | null;
}
