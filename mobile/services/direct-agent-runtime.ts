import { api } from './api';
import type {
  AIRole,
  AgentExecutionProfile,
  AgentLifecycleState,
  MobileAIResolvedConfig,
  OrchestrateAutoWriteSummary,
  SSERoutingEvent,
  WritebackRequestMeta,
} from '@shared/types';
import {
  WRITEBACK_TOOL_NAMES,
  isWritebackToolName,
  transformWritebackToolInput,
  type WritebackToolName,
} from '@shared/agent/writeback-tool-map';

export interface DirectChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  image?: string;
}

export interface DirectPolicySnapshot {
  flow_mode: 'governed';
  approval_fallback: 'auto_approve';
  default_execution_profile: AgentExecutionProfile;
  requested_execution_profile: AgentExecutionProfile;
  effective_execution_profile: AgentExecutionProfile;
  requested_allow_profile_sync: boolean;
  effective_allow_profile_sync: boolean;
  writeback_mode: string;
  readonly_enforced: boolean;
  llm_provider: 'custom_direct';
  llm_model: string;
  llm_role_model: string;
  shadow_readonly_would_apply?: boolean;
}

export interface DirectRuntimeCallbacks {
  onLifecycleState: (state: AgentLifecycleState, detail?: string) => void;
  onStatus: (message: string) => void;
  onRouting: (routing: SSERoutingEvent) => void;
  onTextDelta: (text: string) => void;
  onPolicySnapshot: (snapshot: DirectPolicySnapshot) => void;
  onWritebackSummary: (summary: OrchestrateAutoWriteSummary) => void;
}

interface DirectRuntimeInput {
  config: MobileAIResolvedConfig;
  apiKey: string;
  sessionId: string;
  history: DirectChatHistoryMessage[];
  userText: string;
  imageDataUri?: string;
  allowProfileSync: boolean;
  executionProfile: AgentExecutionProfile;
  requestMeta?: WritebackRequestMeta;
  enqueueWritebackDraft: (draft: {
    draft_id: string;
    tool_call_id?: string;
    summary_text: string;
    payload: Record<string, unknown>;
    context_text: string;
    request_meta?: WritebackRequestMeta;
  }) => void;
  commitWritebackDraft: (draftId: string) => Promise<OrchestrateAutoWriteSummary | null>;
}

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const MAX_TOOL_STEPS = 6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function toRouting(role: AIRole): SSERoutingEvent {
  const roleNameMap: Record<AIRole, string> = {
    doctor: '运动医生',
    rehab: '康复师',
    nutritionist: '营养师',
    trainer: '私人教练',
  };

  return {
    primary_role: role,
    primary_role_name: roleNameMap[role],
    collaborators: [],
    reason: `自定义直连模式：固定角色 ${roleNameMap[role]}`,
  };
}

function buildToolDefinitions(allowProfileSync: boolean): OpenAITool[] {
  const baseTools: OpenAITool[] = [
    {
      type: 'function',
      function: {
        name: 'query_user_data',
        description: '查询用户数据（只读）：user/profile/conditions/training_goals/health_metrics/training_plans/nutrition_plans/diet_records/daily_logs',
        parameters: {
          type: 'object',
          properties: {
            resource: {
              type: 'string',
              enum: [
                'user',
                'profile',
                'conditions',
                'training_goals',
                'health_metrics',
                'training_plans',
                'nutrition_plans',
                'diet_records',
                'daily_logs',
              ],
            },
            status: { type: 'string' },
            metric_type: { type: 'string' },
            plan_kind: { type: 'string', enum: ['nutrition', 'supplement', 'all'] },
            meal_type: { type: 'string' },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['resource'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delegate_generate',
        description: '委托计划模型生成：training_plan/nutrition_plan/supplement_plan/analysis',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['training_plan', 'nutrition_plan', 'supplement_plan', 'analysis'] },
            role: { type: 'string', enum: ['doctor', 'rehab', 'nutritionist', 'trainer'] },
            plan_date: { type: 'string' },
            image_url: { type: 'string' },
            request: { type: 'string' },
          },
          required: ['kind', 'request'],
        },
      },
    },
  ];

  if (!allowProfileSync) return baseTools;

  const writebackTools: OpenAITool[] = WRITEBACK_TOOL_NAMES.map((name) => ({
    type: 'function',
    function: {
      name,
      description: `写回工具：${name}`,
      parameters: {
        type: 'object',
        additionalProperties: true,
      },
    },
  }));

  return [...baseTools, ...writebackTools];
}

function resolveModelCandidates(config: MobileAIResolvedConfig): string[] {
  const models = [config.custom_primary_model.trim(), config.custom_fallback_model.trim()].filter(Boolean);
  return Array.from(new Set(models));
}

function buildRequestTimeGuidance(meta?: WritebackRequestMeta): string {
  if (!meta) {
    return '时间基准：未提供客户端时间，涉及相对日期时请先向用户确认具体日期（YYYY-MM-DD）。';
  }

  const parts: string[] = [];
  if (typeof meta.client_local_date === 'string' && meta.client_local_date.trim()) {
    parts.push(`用户本地日期=${meta.client_local_date.trim()}`);
  }
  if (typeof meta.client_request_at === 'string' && meta.client_request_at.trim()) {
    parts.push(`请求时刻=${meta.client_request_at.trim()}`);
  }
  if (typeof meta.client_timezone === 'string' && meta.client_timezone.trim()) {
    parts.push(`时区=${meta.client_timezone.trim()}`);
  }
  if (typeof meta.client_utc_offset_minutes === 'number' && Number.isFinite(meta.client_utc_offset_minutes)) {
    parts.push(`UTC偏移分钟=${Math.trunc(meta.client_utc_offset_minutes)}`);
  }

  if (parts.length === 0) {
    return '时间基准：未提供客户端时间，涉及相对日期时请先向用户确认具体日期（YYYY-MM-DD）。';
  }

  return `时间基准：${parts.join('，')}。遇到“今天/昨天/前天/明天/本周”等相对日期时，先换算为 YYYY-MM-DD，再写入对应 *_date 字段。`;
}

async function callOpenAICompatible(
  config: MobileAIResolvedConfig,
  apiKey: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${normalizeBaseUrl(config.custom_base_url)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const err = isPlainObject(parsed) && typeof parsed.error === 'object'
      ? JSON.stringify(parsed.error)
      : rawText || `HTTP ${response.status}`;
    throw new Error(`自定义代理调用失败: ${err}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error('自定义代理返回格式错误');
  }

  return parsed;
}

async function callOpenAICompatibleWithFallback(
  config: MobileAIResolvedConfig,
  apiKey: string,
  modelCandidates: string[],
  buildBody: (model: string) => Record<string, unknown>
): Promise<{ model: string; result: Record<string, unknown> }> {
  const errors: string[] = [];

  for (const model of modelCandidates) {
    try {
      const result = await callOpenAICompatible(config, apiKey, buildBody(model));
      return { model, result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${model}: ${msg}`);
    }
  }

  throw new Error(`主备模型均失败: ${errors.join(' | ') || '未知错误'}`);
}

function normalizeAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (isPlainObject(item) ? asString(item.text) : ''))
    .filter(Boolean)
    .join('\n');
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function runQueryUserData(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resource = asString(args.resource);
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(50, Math.floor(args.limit)))
    : 20;

  switch (resource) {
    case 'user': {
      const res = await api.getMe();
      return res.success ? { success: true, data: res.data } : { success: false, error: res.error || '查询失败' };
    }
    case 'profile': {
      const res = await api.getProfile();
      return res.success ? { success: true, data: res.data } : { success: false, error: res.error || '查询失败' };
    }
    case 'conditions': {
      const status = asString(args.status);
      const res = await api.getConditions(status === 'active' || status === 'recovered' ? status : undefined);
      const rows = Array.isArray(res.data) ? res.data.slice(0, limit) : [];
      return res.success ? { success: true, data: rows } : { success: false, error: res.error || '查询失败' };
    }
    case 'training_goals': {
      const status = asString(args.status);
      const res = await api.getTrainingGoals(status === 'active' || status === 'completed' ? status : undefined);
      const rows = Array.isArray(res.data) ? res.data.slice(0, limit) : [];
      return res.success ? { success: true, data: rows } : { success: false, error: res.error || '查询失败' };
    }
    case 'health_metrics': {
      const metricType = asString(args.metric_type);
      const res = await api.getHealthMetrics(metricType || undefined);
      const rows = Array.isArray(res.data) ? res.data.slice(0, limit) : [];
      return res.success ? { success: true, data: rows } : { success: false, error: res.error || '查询失败' };
    }
    case 'training_plans': {
      const res = await api.getTrainingPlans(limit);
      return res.success ? { success: true, data: res.data } : { success: false, error: res.error || '查询失败' };
    }
    case 'nutrition_plans': {
      const planKind = asString(args.plan_kind) || 'all';
      const res = await api.getNutritionPlans(limit * 2);
      if (!res.success) return { success: false, error: res.error || '查询失败' };
      const rows = Array.isArray(res.data) ? res.data : [];
      const filtered = rows.filter((row) => {
        const content = isPlainObject(row) ? asString(row.content) : '';
        const isSupplement = content.startsWith('【补剂方案】');
        if (planKind === 'supplement') return isSupplement;
        if (planKind === 'nutrition') return !isSupplement;
        return true;
      });
      return { success: true, data: filtered.slice(0, limit) };
    }
    case 'diet_records': {
      const dateFrom = asString(args.date_from);
      const dateTo = asString(args.date_to);
      const res = await api.getDietRecords(dateFrom && dateFrom === dateTo ? dateFrom : undefined);
      const rows = Array.isArray(res.data) ? res.data.slice(0, limit) : [];
      return res.success ? { success: true, data: rows } : { success: false, error: res.error || '查询失败' };
    }
    case 'daily_logs': {
      const res = await api.getDailyLogs(limit);
      return res.success ? { success: true, data: res.data } : { success: false, error: res.error || '查询失败' };
    }
    default:
      return { success: false, error: `不支持的资源类型: ${resource || 'unknown'}` };
  }
}

async function runDelegateGenerate(
  config: MobileAIResolvedConfig,
  apiKey: string,
  args: Record<string, unknown>,
  modelCandidates: string[]
): Promise<Record<string, unknown>> {
  const request = asString(args.request);
  if (!request) return { success: false, error: 'delegate_generate 缺少 request' };

  const role = asString(args.role) || 'trainer';
  const kind = asString(args.kind) || 'analysis';
  const planDate = asString(args.plan_date);
  const imageUrl = asString(args.image_url);

  const promptLines = [
    `任务类型：${kind}`,
    `角色：${role}`,
    planDate ? `计划日期：${planDate}` : '',
    imageUrl ? `图片：${imageUrl}` : '',
    '',
    request,
  ].filter(Boolean);

  const { result } = await callOpenAICompatibleWithFallback(
    config,
    apiKey,
    modelCandidates,
    (model) => ({
      model,
      temperature: 0.35,
      stream: false,
      messages: [{ role: 'user', content: promptLines.join('\n') }],
    })
  );

  const choices = Array.isArray(result.choices) ? result.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = isPlainObject(first.message) ? first.message : {};
  const content = normalizeAssistantText(message.content);

  return {
    success: true,
    kind,
    role,
    plan_date: planDate || null,
    content,
  };
}

async function runWritebackTool(
  toolName: WritebackToolName,
  args: Record<string, unknown>,
  contextText: string,
  requestMeta: WritebackRequestMeta | undefined,
  allowProfileSync: boolean,
  enqueueWritebackDraft: DirectRuntimeInput['enqueueWritebackDraft'],
  commitWritebackDraft: DirectRuntimeInput['commitWritebackDraft'],
  callbacks: DirectRuntimeCallbacks
): Promise<Record<string, unknown>> {
  if (!allowProfileSync) {
    return { success: false, error: '当前为只读模式，禁止写回' };
  }

  const transformed = transformWritebackToolInput(toolName, args);
  if (!transformed) {
    return { success: false, error: `写回参数无效: ${toolName}` };
  }

  const draftId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  callbacks.onLifecycleState('writeback_queued', toolName);
  enqueueWritebackDraft({
    draft_id: draftId,
    tool_call_id: `tool-${toolName}-${Date.now()}`,
    summary_text: transformed.summary_text,
    payload: transformed.payload,
    context_text: contextText,
    request_meta: requestMeta,
  });

  callbacks.onLifecycleState('writeback_committing', toolName);
  const summary = await commitWritebackDraft(draftId);
  if (summary) {
    callbacks.onWritebackSummary(summary);
  }

  return {
    success: true,
    draft_id: draftId,
    payload: transformed.payload,
    summary_text: transformed.summary_text,
  };
}

async function executeToolCall(
  toolCall: { id: string; function: { name: string; arguments: string } },
  input: DirectRuntimeInput,
  contextText: string,
  callbacks: DirectRuntimeCallbacks,
  modelCandidates: string[]
): Promise<Record<string, unknown>> {
  const toolName = asString(toolCall.function.name);
  const args = parseToolArgs(toolCall.function.arguments);

  if (toolName === 'query_user_data') {
    return runQueryUserData(args);
  }

  if (toolName === 'delegate_generate') {
    return runDelegateGenerate(input.config, input.apiKey, args, modelCandidates);
  }

  if (isWritebackToolName(toolName)) {
    return runWritebackTool(
      toolName,
      args,
      contextText,
      input.requestMeta,
      input.allowProfileSync,
      input.enqueueWritebackDraft,
      input.commitWritebackDraft,
      callbacks
    );
  }

  return { success: false, error: `未知工具: ${toolName}` };
}

export async function runDirectAgentTurn(
  input: DirectRuntimeInput,
  callbacks: DirectRuntimeCallbacks
): Promise<void> {
  const runtime = await api.getAgentRuntimeContext('trainer', input.sessionId);
  if (!runtime.success || !runtime.data) {
    throw new Error(runtime.error || '获取运行时上下文失败');
  }

  const runtimeData = runtime.data;
  const readonlyEnforced = input.executionProfile === 'plan';
  const effectiveAllowProfileSync = readonlyEnforced ? false : input.allowProfileSync;
  const modelCandidates = resolveModelCandidates(input.config);
  const primaryModel = modelCandidates[0] || '';
  const fallbackModel = modelCandidates[1] || primaryModel;

  callbacks.onPolicySnapshot({
    flow_mode: 'governed',
    approval_fallback: 'auto_approve',
    default_execution_profile: runtimeData.execution_defaults.default_execution_profile,
    requested_execution_profile: input.executionProfile,
    effective_execution_profile: input.executionProfile,
    requested_allow_profile_sync: input.allowProfileSync,
    effective_allow_profile_sync: effectiveAllowProfileSync,
    writeback_mode: runtimeData.writeback_mode,
    readonly_enforced: readonlyEnforced,
    llm_provider: 'custom_direct',
    llm_model: primaryModel,
    llm_role_model: fallbackModel,
  });

  callbacks.onRouting(toRouting(runtimeData.role));
  callbacks.onStatus('处理中');

  const systemPrompt = [
    runtimeData.system_prompt,
    runtimeData.context_text,
    `执行模式：${input.executionProfile}`,
    `写回模式：${runtimeData.writeback_mode}`,
    buildRequestTimeGuidance(input.requestMeta),
  ].join('\n\n');

  const historyMessages: OpenAIMessage[] = input.history.map((item) => {
    const parts: OpenAIMessage['content'] = item.image
      ? [
          { type: 'image_url', image_url: { url: item.image } },
          { type: 'text', text: item.content },
        ]
      : item.content;
    return {
      role: item.role,
      content: parts,
    };
  });

  const userContent: OpenAIMessage['content'] = input.imageDataUri
    ? [
        { type: 'image_url', image_url: { url: input.imageDataUri } },
        { type: 'text', text: input.userText },
      ]
    : input.userText;

  const conversation: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userContent },
  ];

  const tools = buildToolDefinitions(effectiveAllowProfileSync);

  callbacks.onLifecycleState('streaming', 'custom_model_started');

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const { result: completion } = await callOpenAICompatibleWithFallback(
      input.config,
      input.apiKey,
      modelCandidates,
      (model) => ({
        model,
        stream: false,
        temperature: 0.35,
        messages: conversation,
        tools,
        tool_choice: 'auto',
      })
    );

    const choices = Array.isArray(completion.choices) ? completion.choices : [];
    if (choices.length === 0 || !isPlainObject(choices[0])) {
      throw new Error('自定义代理返回 choices 为空');
    }

    const assistant = isPlainObject((choices[0] as Record<string, unknown>).message)
      ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown>)
      : {};

    const assistantText = normalizeAssistantText(assistant.content);
    const rawToolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    const toolCalls = rawToolCalls
      .filter((item) => isPlainObject(item) && isPlainObject(item.function))
      .map((item) => ({
        id: asString((item as Record<string, unknown>).id) || `tool-${Date.now()}`,
        function: {
          name: asString(((item as Record<string, unknown>).function as Record<string, unknown>).name),
          arguments: asString(((item as Record<string, unknown>).function as Record<string, unknown>).arguments),
        },
      }))
      .filter((item) => item.function.name.length > 0);

    conversation.push({
      role: 'assistant',
      content: assistantText,
      tool_calls: toolCalls.length > 0
        ? toolCalls.map((call) => ({ id: call.id, type: 'function', function: call.function }))
        : undefined,
    });

    if (assistantText.trim()) {
      callbacks.onTextDelta(assistantText);
    }

    if (toolCalls.length === 0) {
      callbacks.onLifecycleState('done', 'custom_model_finished');
      return;
    }

    callbacks.onLifecycleState('tool_running', `step_${step + 1}`);

    for (const toolCall of toolCalls) {
      const toolResult = await executeToolCall(toolCall, input, runtimeData.context_text, callbacks, modelCandidates);
      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  callbacks.onLifecycleState('done', 'custom_max_steps_reached');
}
