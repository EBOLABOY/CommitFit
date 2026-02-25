import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { streamText, tool, convertToModelMessages, stepCountIs, type StreamTextOnFinishCallback, type ToolSet } from 'ai';
import type { Connection, ConnectionContext } from 'agents';
import { jwtVerify } from 'jose';
import type { AIRole } from '../../../shared/types';
import type { Bindings } from '../types';
import { getMainLLMModel, getRoleLLMModel } from '../services/ai-provider';
import { syncProfileToolSchema } from './sync-profile-tool';
import { queryUserDataToolSchema } from './query-user-data-tool';
import { delegateGenerateToolSchema } from './delegate-generate-tool';
import type {
  CustomBroadcast,
  RoutingBroadcast,
  ProfileSyncResultBroadcast,
} from './contracts';
import {
  ROLE_NAMES,
  SYSTEM_PROMPTS,
  saveOrchestrateAssistantMessage,
  saveOrchestrateUserMessage,
  applyAutoWriteback,
  recordWritebackAudit,
} from '../services/orchestrator';
import { getUserContext, buildContextForRole, estimateTokens } from '../services/context';

// Helper: extract plain text from a UIMessage's parts array
function extractText(msg: { parts?: Array<{ type: string; text?: string }> }): string {
  if (!msg.parts || !Array.isArray(msg.parts)) return '';
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

const TOTAL_CONTEXT_TOKEN_BUDGET = 12000;
const RESERVED_OUTPUT_TOKENS = 2000;
const MIN_HISTORY_TOKEN_BUDGET = 2000;
const WS_CONNECT_WINDOW_SECONDS = 60;
const WS_CONNECT_USER_LIMIT = 30;
const WS_CONNECT_IP_LIMIT = 60;

type RateLimitState = {
  timestamps: number[];
};

type AgentMessagePart = {
  type?: string;
  text?: string;
  url?: string;
};

type AgentMessageLike = {
  role?: string;
  parts?: AgentMessagePart[];
  content?: unknown;
};

function parseUserIdFromAgentName(agentName: string): string {
  let normalized = agentName;
  try {
    normalized = decodeURIComponent(agentName);
  } catch {
    normalized = agentName;
  }
  const idx = normalized.indexOf(':');
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

function getClientIP(headers: Headers): string {
  const cfIP = headers.get('CF-Connecting-IP');
  if (cfIP && cfIP.trim()) return cfIP.trim();

  const forwardedFor = headers.get('X-Forwarded-For');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

function getConnectRateLimitKey(scope: 'user' | 'ip', value: string): string {
  return `rate:ws-connect:${scope}:${value}`;
}

async function consumeConnectRateLimit(
  env: Bindings,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const ttlSeconds = windowSeconds + 30;
  const raw = await env.KV.get(key, 'json');
  const state = raw && typeof raw === 'object' ? (raw as RateLimitState) : null;
  const timestamps = (state?.timestamps || []).filter((ts) => ts > now - windowMs);

  if (timestamps.length >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  timestamps.push(now);
  await env.KV.put(key, JSON.stringify({ timestamps }), { expirationTtl: ttlSeconds });
  return { allowed: true, retryAfterSeconds: 0 };
}

function isValidPreferredRole(value: unknown): value is AIRole {
  return value === 'doctor' || value === 'rehab' || value === 'nutritionist' || value === 'trainer';
}

function resolveActiveRole(value: string | undefined): AIRole {
  if (isValidPreferredRole(value)) return value;
  return 'trainer';
}

function extractImageUrl(msg: AgentMessageLike | undefined): string | null {
  if (!msg?.parts || !Array.isArray(msg.parts)) return null;
  for (const part of msg.parts) {
    if ((part.type === 'file' || part.type === 'image' || part.type === 'image_url') && typeof part.url === 'string') {
      return part.url.slice(0, 512);
    }
  }
  return null;
}

function estimateAgentMessageTokens(msg: AgentMessageLike): number {
  let total = 6;

  if (Array.isArray(msg.parts) && msg.parts.length > 0) {
    for (const part of msg.parts) {
      if (part.type === 'text') {
        total += estimateTokens(typeof part.text === 'string' ? part.text : '');
        continue;
      }
      if (part.type === 'file' || part.type === 'image' || part.type === 'image_url') {
        total += 85;
        continue;
      }
      total += 12;
    }
    return total;
  }

  if (typeof msg.content === 'string') {
    total += estimateTokens(msg.content);
  }
  return total;
}

function trimConversationByTokenBudget<T extends AgentMessageLike>(messages: T[], maxTokens: number): T[] {
  if (messages.length <= 1) return messages;

  let total = 0;
  const kept: T[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const msgTokens = estimateAgentMessageTokens(msg);
    if (kept.length === 0 || total + msgTokens <= maxTokens) {
      kept.unshift(msg);
      total += msgTokens;
    }
  }

  return kept.length > 0 ? kept : [messages[messages.length - 1]];
}

// tool-invocation part 中"缺少结果"的状态集合
const INCOMPLETE_TOOL_STATES = new Set([
  'approval-requested',   // 等待用户审批，结果尚未确认
  'approval-responded',   // 用户已响应但 LLM 续跑尚未写回 output
  'input-available',      // 输入已就绪但 execute 尚未完成
  'input-streaming',      // 输入流式接收中，尚未执行
]);

/**
 * 清理消息历史中「孤立的 tool-invocation」part，防止 convertToModelMessages 报错。
 *
 * 问题根因（旧架构）：
 *   sync_profile 工具设置了 needsApproval: true（远端直写 + 人工确认），AIChatAgent 会在
 *   approval-requested 状态时将 assistant 消息持久化到 SQLite。
 *   若用户此时关闭 App 或断网，tool_result 永远不会写回。
 *   下次发消息时 convertToModelMessages 检测到"有 tool_call 无 tool_result"
 *   便抛出 "Tool result is missing for tool call ..." 错误。
 *
 * 解决策略：
 *   丢弃状态不完整的 tool part；若 assistant 消息过滤后仍有文字内容则保留，
 *   否则整条消息丢弃，确保传给 LLM 的历史格式合法。
 */
function sanitizeMessagesForLLM(messages: AgentMessageLike[]): AgentMessageLike[] {
  const result: AgentMessageLike[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') {
      result.push(msg);
      continue;
    }

    const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;
    const hasOrphanedTool = parts.some(
      (p) => typeof p.toolCallId === 'string' && INCOMPLETE_TOOL_STATES.has((p.state ?? '') as string)
    );

    if (!hasOrphanedTool) {
      result.push(msg);
      continue;
    }

    // 过滤：保留非孤立 part，丢弃孤立 tool-invocation
    const cleanedParts = parts.filter((p) =>
      !(typeof p.toolCallId === 'string' && INCOMPLETE_TOOL_STATES.has((p.state ?? '') as string))
    );

    // 只保留还有 text 内容的 assistant 消息
    const hasText = cleanedParts.some(
      (p) => p.type === 'text' && typeof p.text === 'string' && (p.text as string).trim().length > 0
    );
    if (hasText) {
      result.push({ ...msg, parts: cleanedParts as AgentMessagePart[] });
    }
    // 若 assistant 消息里只有 tool call（无文字），整条丢弃
  }

  return result;
}

export class SupervisorAgent extends AIChatAgent<Bindings> {
  // --- WebSocket JWT Authentication ---

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get('token');
    if (!token) {
      connection.close(4001, 'Missing token');
      return;
    }

    const expectedUserId = parseUserIdFromAgentName(this.name);
    const clientIp = getClientIP(ctx.request.headers);

    try {
      const secret = new TextEncoder().encode(this.env.JWT_SECRET);
      const { payload } = await jwtVerify(token, secret);
      const tokenUserId = typeof payload.sub === 'string' ? payload.sub : '';
      if (!tokenUserId || tokenUserId !== expectedUserId) {
        connection.close(4003, 'Token user mismatch');
        return;
      }

      try {
        const userLimit = await consumeConnectRateLimit(
          this.env,
          getConnectRateLimitKey('user', tokenUserId),
          WS_CONNECT_USER_LIMIT,
          WS_CONNECT_WINDOW_SECONDS
        );
        if (!userLimit.allowed) {
          connection.close(4008, `Too many connections, retry in ${userLimit.retryAfterSeconds}s`);
          return;
        }

        const ipLimit = await consumeConnectRateLimit(
          this.env,
          getConnectRateLimitKey('ip', clientIp),
          WS_CONNECT_IP_LIMIT,
          WS_CONNECT_WINDOW_SECONDS
        );
        if (!ipLimit.allowed) {
          connection.close(4008, `Too many connections, retry in ${ipLimit.retryAfterSeconds}s`);
          return;
        }
      } catch (error) {
        // 限流存储故障时放行，避免误伤正常会话。
        console.error('[SupervisorAgent] ws connect rate-limit failed:', error);
      }
    } catch {
      connection.close(4001, 'Invalid token');
      return;
    }
    // Auth OK — let AIChatAgent handle the rest
    await super.onConnect(connection, ctx);
  }

  // --- Core Chat Handler ---

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const userId = parseUserIdFromAgentName(this.name);
    const body = options?.body && typeof options.body === 'object'
      ? (options.body as Record<string, unknown>)
      : {};
    const requestedRole = isValidPreferredRole(body.preferred_role) ? body.preferred_role : null;
    const activeRole = resolveActiveRole(this.env.ACTIVE_AI_ROLE);
    const allowProfileSync = body.allow_profile_sync !== false;

    const textResponse = (text: string): Response =>
      new Response(text, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });

    try {
      // 1. Extract latest user message from UIMessage parts
      const lastUserMsg = [...this.messages].reverse().find((m) => m.role === 'user');
      const userText = lastUserMsg ? extractText(lastUserMsg) : '';
      const userImageUrl = extractImageUrl(lastUserMsg as AgentMessageLike | undefined);
      const hasImageInput = Boolean(userImageUrl);

      if (!userText.trim()) {
        return textResponse('请先输入你的问题');
      }

      // Persist user message before streaming so mid-stream failures still keep audit data.
      try {
        await saveOrchestrateUserMessage(this.env.DB, userId, userText, userImageUrl);
      } catch {
        // keep chat flow resilient even if audit write fails
      }

      // 2. Build history for routing (last 16 messages as simple text)
      const history = this.messages
        .slice(-16)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: extractText(m),
        }))
        .filter((m) => m.content.trim().length > 0);

      // 3. 单角色固定模式：不再进行多角色路由
      this.broadcastCustom({ type: 'status', message: '单角色模式处理中...' });
      const routing: { primaryRole: AIRole; collaborators: AIRole[]; reason: string } = {
        primaryRole: activeRole,
        collaborators: [],
        reason:
          requestedRole && requestedRole !== activeRole
            ? `单角色固定为 ${ROLE_NAMES[activeRole]}，忽略请求角色 ${ROLE_NAMES[requestedRole]}`
            : `单角色固定为 ${ROLE_NAMES[activeRole]}`,
      };

      // 4. Broadcast routing info
      const routingBroadcast: RoutingBroadcast = {
        type: 'routing',
        primary_role: routing.primaryRole,
        primary_role_name: ROLE_NAMES[routing.primaryRole],
        collaborators: routing.collaborators.map((r) => ({
          role: r,
          role_name: ROLE_NAMES[r],
        })),
        reason: routing.reason,
      };
      this.broadcastCustom(routingBroadcast);

      // 5. Build system prompt with user context
      this.broadcastCustom({ type: 'status', message: '正在查阅你的档案...' });
      let userContext: Awaited<ReturnType<typeof getUserContext>>;
      try {
        userContext = await getUserContext(this.env.DB, userId);
      } catch {
        userContext = {
          profile: null,
          healthMetrics: [],
          conditions: [],
          trainingGoals: [],
          recentTraining: [],
          recentNutrition: [],
          recentDiet: [],
          recentDailyLogs: [],
        };
      }
      const contextStr = buildContextForRole(activeRole, userContext);
      const architectureGuidanceLines: string[] = [
        '架构要点：主模型负责对话与工具编排；计划/方案/图片分析用 delegate_generate（工具输出可流式展示）；需要保存/更新时先 query_user_data 查看同日旧内容并决定覆盖或合并，再用 sync_profile 写回（同日只保留一份）；禁止账号/密码类操作；禁止把客套话写入数据。',
      ];
      if (hasImageInput && userImageUrl) {
        architectureGuidanceLines.push(`本次输入包含图片 URL：${userImageUrl}`);
      }
      const systemPrompt = SYSTEM_PROMPTS[activeRole] + '\n\n' + contextStr + '\n\n' + architectureGuidanceLines.join('\n');
      const systemPromptTokens = estimateTokens(systemPrompt);
      const historyTokenBudget = Math.max(
        MIN_HISTORY_TOKEN_BUDGET,
        TOTAL_CONTEXT_TOKEN_BUDGET - systemPromptTokens - RESERVED_OUTPUT_TOKENS
      );
      // 先清理历史中状态不完整的 tool-invocation（如 approval-requested），
      // 防止 convertToModelMessages 因"有 tool_call 无 tool_result"而报错
      const sanitizedMessages = sanitizeMessagesForLLM([...this.messages]);
      const trimmedConversation = trimConversationByTokenBudget(sanitizedMessages, historyTokenBudget);

      this.broadcastCustom({ type: 'status', message: `正在呼叫【${ROLE_NAMES[activeRole]}】...` });

      // 6. Stream response via AI SDK
      const model = getMainLLMModel(this.env);
      const modelAlias = 'LLM';
      this.broadcastCustom({ type: 'status', message: '主模型流式处理中（生成/分析类任务将委托深度生成器）...' });

      const writebackModeRaw = typeof this.env.WRITEBACK_MODE === 'string' ? this.env.WRITEBACK_MODE : 'remote';
      const writebackMode = writebackModeRaw.toLowerCase();
      const isLocalFirstWriteback = writebackMode !== 'remote';

      const queryUserDataTool = tool({
        description: [
          '查询用户数据（只读）。用于回答用户关于其历史记录/当前数据的问题。',
          '禁止返回或推断任何账户/密码敏感信息（如 password_hash、JWT_SECRET、LLM_API_KEY 等）。',
          '返回结果请尽量简洁，必要时让用户缩小时间范围或指定条目。',
        ].join('\n'),
        inputSchema: queryUserDataToolSchema,
        execute: async (args) => {
          const truncate = (text: unknown, max = 2000): string | null => {
            if (typeof text !== 'string') return null;
            if (text.length <= max) return text;
            return `${text.slice(0, max)}...(已截断)`;
          };

          const limitRaw = (args as Record<string, unknown>).limit;
          const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;

          switch (args.resource) {
            case 'user': {
              const user = await this.env.DB.prepare('SELECT id, nickname, avatar_key FROM users WHERE id = ?')
                .bind(userId)
                .first();
              return { success: true, data: user };
            }
            case 'profile': {
              const profile = await this.env.DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?')
                .bind(userId)
                .first();
              return { success: true, data: profile };
            }
            case 'conditions': {
              const status = args.status && args.status !== 'all' ? args.status : null;
              const sql = status
                ? "SELECT * FROM conditions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
                : 'SELECT * FROM conditions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?';
              const res = status
                ? await this.env.DB.prepare(sql).bind(userId, status, limit).all()
                : await this.env.DB.prepare(sql).bind(userId, limit).all();
              return { success: true, data: res.results || [] };
            }
            case 'training_goals': {
              const status = args.status && args.status !== 'all' ? args.status : null;
              const sql = status
                ? "SELECT * FROM training_goals WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
                : 'SELECT * FROM training_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?';
              const res = status
                ? await this.env.DB.prepare(sql).bind(userId, status, limit).all()
                : await this.env.DB.prepare(sql).bind(userId, limit).all();
              return { success: true, data: res.results || [] };
            }
            case 'health_metrics': {
              const clauses: string[] = ['user_id = ?'];
              const params: unknown[] = [userId];
              if (args.metric_type) {
                clauses.push('metric_type = ?');
                params.push(args.metric_type);
              }
              if (args.date_from) {
                clauses.push('recorded_at >= ?');
                params.push(args.date_from);
              }
              if (args.date_to) {
                clauses.push('recorded_at <= ?');
                params.push(args.date_to);
              }
              params.push(limit);
              const res = await this.env.DB.prepare(
                `SELECT * FROM health_metrics WHERE ${clauses.join(' AND ')} ORDER BY recorded_at DESC, created_at DESC LIMIT ?`
              ).bind(...params).all();
              return { success: true, data: res.results || [] };
            }
            case 'training_plans': {
              const l = Math.min(limit, 30);
              const clauses: string[] = ['user_id = ?'];
              const params: unknown[] = [userId];
              if (args.date_from) {
                clauses.push('plan_date >= ?');
                params.push(args.date_from);
              }
              if (args.date_to) {
                clauses.push('plan_date <= ?');
                params.push(args.date_to);
              }
              params.push(l);
              const res = await this.env.DB.prepare(
                `SELECT * FROM training_plans WHERE ${clauses.join(' AND ')} ORDER BY plan_date DESC LIMIT ?`
              ).bind(...params).all();
              const rows = (res.results || []).map((row) => {
                const r = row as Record<string, unknown>;
                if (r.content) r.content = truncate(r.content, 2400);
                if (r.notes) r.notes = truncate(r.notes, 800);
                return r;
              });
              return { success: true, data: rows };
            }
            case 'nutrition_plans': {
              const l = Math.min(limit, 30);
              const clauses: string[] = ['user_id = ?'];
              const params: unknown[] = [userId];
              if (args.date_from) {
                clauses.push('plan_date >= ?');
                params.push(args.date_from);
              }
              if (args.date_to) {
                clauses.push('plan_date <= ?');
                params.push(args.date_to);
              }
              if (args.plan_kind === 'supplement') {
                clauses.push("content LIKE '【补剂方案】%'");
              } else if (args.plan_kind === 'nutrition') {
                clauses.push("content NOT LIKE '【补剂方案】%'");
              }
              params.push(l);
              const res = await this.env.DB.prepare(
                `SELECT * FROM nutrition_plans WHERE ${clauses.join(' AND ')} ORDER BY plan_date DESC LIMIT ?`
              ).bind(...params).all();
              const rows = (res.results || []).map((row) => {
                const r = row as Record<string, unknown>;
                if (r.content) r.content = truncate(r.content, 2400);
                return r;
              });
              return { success: true, data: rows };
            }
            case 'diet_records': {
              const clauses: string[] = ['user_id = ?'];
              const params: unknown[] = [userId];
              if (args.meal_type) {
                clauses.push('meal_type = ?');
                params.push(args.meal_type);
              }
              if (args.date_from) {
                clauses.push('record_date >= ?');
                params.push(args.date_from);
              }
              if (args.date_to) {
                clauses.push('record_date <= ?');
                params.push(args.date_to);
              }
              params.push(limit);
              const res = await this.env.DB.prepare(
                `SELECT * FROM diet_records WHERE ${clauses.join(' AND ')} ORDER BY record_date DESC, created_at DESC LIMIT ?`
              ).bind(...params).all();
              const rows = (res.results || []).map((row) => {
                const r = row as Record<string, unknown>;
                if (r.food_description) r.food_description = truncate(r.food_description, 1200);
                if (r.foods_json) r.foods_json = truncate(r.foods_json, 2400);
                return r;
              });
              return { success: true, data: rows };
            }
            case 'daily_logs': {
              const clauses: string[] = ['user_id = ?'];
              const params: unknown[] = [userId];
              if (args.date_from) {
                clauses.push('log_date >= ?');
                params.push(args.date_from);
              }
              if (args.date_to) {
                clauses.push('log_date <= ?');
                params.push(args.date_to);
              }
              params.push(limit);
              const res = await this.env.DB.prepare(
                `SELECT * FROM daily_logs WHERE ${clauses.join(' AND ')} ORDER BY log_date DESC LIMIT ?`
              ).bind(...params).all();
              return { success: true, data: res.results || [] };
            }
          }
        },
      });

      const delegateGenerateTool = tool({
        description: [
          '委托深度生成器（LLM1）。用于训练计划/饮食方案/补剂方案的生成，以及图片识别/分析等“长文本/复杂生成”任务。',
          '返回内容必须是“可直接保存/粘贴”的正文，不要包含任何客套话、确认语、免责声明，也不要提及工具/模型/调用过程。',
          '该工具支持以 tool-output 的 preliminary 形式流式返回增量内容（前端可实时展示）。',
          '当用户只是解释、问答、常规增删改查时，不要调用此工具。',
        ].join('\n'),
        inputSchema: delegateGenerateToolSchema,
        // 流式委托：工具 execute 返回 AsyncIterable，AI SDK 会把每次 yield 作为 preliminary tool-result 推送给前端。
        // 注意：只有“最后一次 yield”的输出会作为最终 tool-result 提供给主模型继续推理。
        execute: (args, toolOptions) => {
          const truncate = (value: unknown, max = 500): string => {
            const text = typeof value === 'string' ? value : '';
            const clean = text.trim();
            if (!clean) return '';
            return clean.length <= max ? clean : `${clean.slice(0, max)}...(已截断)`;
          };

          const toDateOnlyUTC = (d: Date): string => d.toISOString().slice(0, 10);

          const dateDaysAgoUTC = (days: number): string => {
            const ms = Date.now() - days * 24 * 60 * 60 * 1000;
            return toDateOnlyUTC(new Date(ms));
          };

          const calcAgeYears = (birthDate: unknown): number | null => {
            if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
            const [y, m, d] = birthDate.split('-').map((v) => Number(v));
            if (!y || !m || !d) return null;
            const now = new Date();
            let age = now.getUTCFullYear() - y;
            const mm = now.getUTCMonth() + 1;
            const dd = now.getUTCDate();
            if (mm < m || (mm === m && dd < d)) age -= 1;
            return Number.isFinite(age) && age >= 0 && age <= 120 ? age : null;
          };

          const formatMealType = (value: unknown): string => {
            switch (value) {
              case 'breakfast': return '早餐';
              case 'lunch': return '午餐';
              case 'dinner': return '晚餐';
              case 'snack': return '加餐';
              default: return '未知';
            }
          };

          const abortSignal = toolOptions?.abortSignal;
          const agent = this;
          return (async function* () {
            try {
              const kind = args.kind;
              const roleRaw = (args as Record<string, unknown>).role;
              const delegateRole = isValidPreferredRole(roleRaw) ? roleRaw : activeRole;
              const planDateHint = typeof (args as Record<string, unknown>).plan_date === 'string'
                ? ((args as Record<string, unknown>).plan_date as string)
                : null;
              const imageUrlRaw = typeof (args as Record<string, unknown>).image_url === 'string'
                ? ((args as Record<string, unknown>).image_url as string)
                : null;

              const kindLabel =
                kind === 'training_plan'
                  ? '训练计划'
                  : kind === 'nutrition_plan'
                    ? '饮食方案'
                    : kind === 'supplement_plan'
                      ? '补剂方案'
                      : '分析';
              agent.broadcastCustom({ type: 'status', message: `正在委托深度生成器：${kindLabel}...` });

              // 只在委托生成时补充更丰富的用户事实（避免放大主链路 prompt）。
              const since30 = dateDaysAgoUTC(30);
              const since7 = dateDaysAgoUTC(7);

              const [weightsRes, plansRes, dietRes, supplementRes] = await Promise.all([
                agent.env.DB
                  .prepare('SELECT log_date, weight FROM daily_logs WHERE user_id = ? AND log_date >= ? AND weight IS NOT NULL ORDER BY log_date DESC LIMIT 40')
                  .bind(userId, since30)
                  .all(),
                agent.env.DB
                  .prepare('SELECT plan_date, content, notes, completed FROM training_plans WHERE user_id = ? AND plan_date >= ? ORDER BY plan_date DESC LIMIT 14')
                  .bind(userId, since7)
                  .all(),
                agent.env.DB
                  .prepare('SELECT record_date, meal_type, food_description, calories, protein, fat, carbs FROM diet_records WHERE user_id = ? AND record_date >= ? ORDER BY record_date DESC, meal_type ASC LIMIT 80')
                  .bind(userId, since7)
                  .all(),
                agent.env.DB
                  .prepare("SELECT plan_date, content FROM nutrition_plans WHERE user_id = ? AND content LIKE '【补剂方案】%' ORDER BY plan_date DESC LIMIT 2")
                  .bind(userId)
                  .all(),
              ]);

              const profile = userContext.profile && typeof userContext.profile === 'object' ? userContext.profile : null;
              const birthDate = profile ? (profile.birth_date as unknown) : null;
              const gender = profile ? (profile.gender as unknown) : null;
              const genderZh = gender === 'male' ? '男' : gender === 'female' ? '女' : '未填';
              const ageYears = calcAgeYears(birthDate);

              const goals = Array.isArray(userContext.trainingGoals)
                ? userContext.trainingGoals.slice(0, 4).map((g) => {
                  const name = truncate((g as Record<string, unknown>).name, 80);
                  const desc = truncate((g as Record<string, unknown>).description, 2000);
                  return desc ? `${name}：${desc}` : name;
                }).filter(Boolean)
                : [];

              const conditions = Array.isArray(userContext.conditions)
                ? userContext.conditions.slice(0, 6).map((c) => {
                  const name = truncate((c as Record<string, unknown>).name, 80);
                  const severity = truncate((c as Record<string, unknown>).severity, 20);
                  const desc = truncate((c as Record<string, unknown>).description, 1200);
                  const sev = severity ? `（${severity}）` : '';
                  return desc ? `${name}${sev}：${desc}` : `${name}${sev}`;
                }).filter(Boolean)
                : [];

              const weights = (weightsRes.results || [])
                .map((r: unknown) => r as Record<string, unknown>)
                .filter((r: Record<string, unknown>) => typeof r.log_date === 'string' && typeof r.weight === 'number')
                .slice(0, 31)
                .reverse()
                .map((r: Record<string, unknown>) => `${r.log_date}:${(r.weight as number).toFixed(1)}kg`)
                .join('，');

              const recentPlans = (plansRes.results || [])
                .map((r: unknown) => r as Record<string, unknown>)
                .filter((r: Record<string, unknown>) => typeof r.plan_date === 'string')
                .slice(0, 7)
                .map((r: Record<string, unknown>) => {
                  const d = r.plan_date as string;
                  const done = r.completed === 1 || r.completed === true ? '已完成' : '未完成';
                  const summary = truncate(r.content, 320);
                  return `- ${d}（${done}）：${summary}`;
                })
                .join('\n');

              const dietByDate = new Map<string, Array<Record<string, unknown>>>();
              for (const row of (dietRes.results || []) as Array<Record<string, unknown>>) {
                const d = typeof row.record_date === 'string' ? row.record_date : null;
                if (!d) continue;
                const arr = dietByDate.get(d) ?? [];
                arr.push(row);
                dietByDate.set(d, arr);
              }
              const dietDates = Array.from(dietByDate.keys()).sort().reverse().slice(0, 7);
              const recentDiet = dietDates.map((d) => {
                const items = dietByDate.get(d) ?? [];
                const parts = items.slice(0, 6).map((it) => {
                  const meal = formatMealType(it.meal_type);
                  const desc = truncate(it.food_description, 120);
                  return desc ? `${meal}:${desc}` : meal;
                }).filter(Boolean);
                return `- ${d}：${parts.join(' | ')}`;
              }).join('\n');

              const supplementPlans = (supplementRes.results || [])
                .map((r: unknown) => r as Record<string, unknown>)
                .filter((r: Record<string, unknown>) => typeof r.plan_date === 'string' && typeof r.content === 'string')
                .slice(0, 2)
                .map((r: Record<string, unknown>) => `- ${r.plan_date}：${truncate(r.content, 600)}`)
                .join('\n');

              const userFactsLines: string[] = [
                '用户信息（供生成参考，缺失项可忽略）：',
                profile
                  ? [
                    `- 年龄：${ageYears ?? '未知'}${ageYears != null ? '岁' : ''}`,
                    `- 性别：${genderZh}`,
                    `- 身高：${typeof profile.height === 'number' ? `${profile.height}cm` : '未填'}`,
                    `- 训练年限：${typeof profile.training_years === 'number' ? `${profile.training_years}年` : '未填'}`,
                  ].join('\n')
                  : '- 身体基础信息：未填写',
                goals.length > 0 ? `- 目标：\n${goals.map((g) => `  - ${g}`).join('\n')}` : '- 目标：未设置',
                conditions.length > 0 ? `- 伤病：\n${conditions.map((c) => `  - ${c}`).join('\n')}` : '- 伤病：无/未记录',
                weights ? `- 近30天体重（日志）：${weights}` : '- 近30天体重（日志）：无',
                recentPlans ? `- 近7天训练计划（摘要）：\n${recentPlans}` : '- 近7天训练计划：无',
                recentDiet ? `- 近7天饮食（摘要）：\n${recentDiet}` : '- 近7天饮食：无',
                supplementPlans ? `- 最近补剂方案（如有）：\n${supplementPlans}` : '- 最近补剂方案：无',
              ];

              const delegateSystem = [
                // 不复用长角色 prompt，减少限制与 token 占用，让模型更主动。
                kind === 'nutrition_plan' || kind === 'supplement_plan' ? '你是运动营养与补剂规划专家。' :
                  kind === 'training_plan' ? '你是力量与体能训练教练。' :
                    '你是运动健康分析顾问。',
                '你被主助理以工具形式调用。只输出最终内容（中文 Markdown），不要客套话，不要解释过程，不要提及工具/模型/调用。',
                '优先利用用户信息生成更贴合的方案；信息不足时提出少量关键问题，同时给出一个可执行的最小版本。',
              ].join('\n');

              const kindRequirements =
                kind === 'training_plan'
                  ? [
                    '生成训练计划：包含 热身/主训练/辅助/拉伸恢复；给出组数×次数×强度（RPE或重量区间）；',
                    '如用户给出“今天/明天/本周/一周”，请在正文中显式写明对应的日期或范围；',
                  ].join('\n')
                  : kind === 'nutrition_plan'
                    ? [
                      '生成饮食方案：按餐次给建议（早餐/午餐/晚餐/加餐）；给出蛋白/碳水/脂肪大致范围；',
                      '如有减脂/增肌目标，给出总热量策略与可执行替代食材。',
                    ].join('\n')
                    : kind === 'supplement_plan'
                      ? [
                        '生成补剂方案：给出补剂清单、剂量、时机、注意事项；避免夸大疗效；',
                        '对肝肾/睡眠/血压风险给出简短提示。',
                      ].join('\n')
                      : [
                        '分析任务：给出结论要点 + 依据（简短） + 下一步建议；不要长篇空话。',
                      ].join('\n');

              const promptLines = [
                `任务类型：${kind}`,
                `角色视角：${ROLE_NAMES[delegateRole]}`,
                planDateHint ? `计划日期（如适用）：${planDateHint}` : null,
                imageUrlRaw ? `图片URL：${imageUrlRaw}` : null,
                '',
                userFactsLines.join('\n'),
                '',
                '用户请求：',
                args.request,
                '',
                '输出要求：',
                kindRequirements,
              ].filter(Boolean) as string[];
              const prompt = promptLines.join('\n');

              const roleModel = getRoleLLMModel(agent.env);
              const maxOutputTokens =
                kind === 'training_plan' ? 1800 :
                  kind === 'analysis' ? 1200 :
                    1600;
              const temperature = kind === 'analysis' ? 0.2 : 0.5;

              const stream = imageUrlRaw
                ? streamText({
                  model: roleModel,
                  system: delegateSystem,
                  messages: [{
                    role: 'user',
                    content: [
                      { type: 'text', text: prompt },
                      { type: 'image', image: new URL(imageUrlRaw) },
                    ],
                  }],
                  maxOutputTokens,
                  temperature,
                  abortSignal,
                })
                : streamText({
                  model: roleModel,
                  system: delegateSystem,
                  prompt,
                  maxOutputTokens,
                  temperature,
                  abortSignal,
                });

              let fullText = '';
              let buffer = '';
              let lastFlushAt = Date.now();

              for await (const delta of stream.textStream) {
                if (!delta) continue;
                fullText += delta;
                buffer += delta;

                const now = Date.now();
                if (buffer.length >= 120 || now - lastFlushAt >= 220) {
                  yield { kind, delta: buffer };
                  buffer = '';
                  lastFlushAt = now;
                }
              }
              if (buffer) {
                yield { kind, delta: buffer };
              }

              const text = fullText.trim();
              const content = text.length > 12000 ? `${text.slice(0, 12000)}...(已截断)` : text;
              yield {
                success: true,
                kind,
                role: delegateRole,
                plan_date: planDateHint,
                content,
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : '委托生成失败';
              yield { success: false, error: message };
            }
          })();
        },
      });

      const syncProfileTool = tool({
        description: [
          '当用户在对话中明确给出可写回的数据/操作（身体档案、伤病记录、训练目标、训练计划、饮食记录、日志等）时调用，用于把信息同步到用户数据。',
          '重要：写回内容必须来自用户原话/近期对话中的事实，不要把助手的确认语、客套话（如“好的/已记录/明白了”）写入任何字段。',
          '清空伤病记录：设置 conditions_mode="clear_all"，不要传 conditions。',
          '清空训练目标：设置 training_goals_mode="clear_all"，不要编造 training_goals。',
          '先清空再写入：分别使用 *_mode="replace_all" 并提供对应列表。',
          '按 id 删除指定条目：使用 *_delete_ids（例如 conditions_delete_ids、training_goals_delete_ids、health_metrics_delete_ids）。',
          '当你刚生成训练计划/饮食方案/补剂方案且用户希望保存/替换/更新时，使用对应的 *_plan 写回；如同日已存在，先用 query_user_data 拉取旧内容，再决定覆盖或合并（最终同日只保留一份）。',
          '删除某天训练计划：设置 training_plan_delete_date="YYYY-MM-DD"（也可以用“今天/明天/本周”让系统推断）。',
          '删除饮食记录：使用 diet_records_delete（优先 id；否则 meal_type + record_date）。',
          '禁止操作账户/密码相关字段（email/password/account/password_hash/JWT 等）。',
          '当你确定需要写回时即可调用（可在生成结果后、最终答复前调用）。',
        ].join('\n'),
        inputSchema: syncProfileToolSchema,
        // Local-First：工具仅生成草稿，不直接写远端，因此不需要人工审批。
        // remote 模式保留旧行为（直写远端 + needsApproval）以便回滚/灰度。
        needsApproval: !isLocalFirstWriteback,
        execute: async (args) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { summary_text, ...writebackPayload } = args;

            if (!isLocalFirstWriteback) {
              const summary = await applyAutoWriteback(this.env.DB, userId, writebackPayload, {
                contextText: userText,
              });
              const syncBroadcast: ProfileSyncResultBroadcast = {
                type: 'profile_sync_result',
                summary,
              };
              this.broadcastCustom(syncBroadcast);
              try {
                await recordWritebackAudit(this.env.DB, userId, 'orchestrate_stream', summary, null, userText);
              } catch { /* ignore */ }
              return { success: true, summary_text: args.summary_text, changes: summary };
            }

            const draftId = crypto.randomUUID();
            return {
              success: true,
              draft_id: draftId,
              summary_text,
              payload: writebackPayload,
              context_text: userText,
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : '档案同步失败';
            if (!isLocalFirstWriteback) {
              try {
                await recordWritebackAudit(this.env.DB, userId, 'orchestrate_stream', null, errMsg, userText);
              } catch { /* ignore */ }
            }
            return { success: false, error: errMsg };
          }
        },
      });

      const result = streamText({
        model,
        system: systemPrompt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: await convertToModelMessages(trimmedConversation as any),
        tools: allowProfileSync
          ? { query_user_data: queryUserDataTool, delegate_generate: delegateGenerateTool, sync_profile: syncProfileTool }
          : { query_user_data: queryUserDataTool, delegate_generate: delegateGenerateTool },
        stopWhen: allowProfileSync ? stepCountIs(6) : stepCountIs(4),
        onFinish: async (event) => {
          const text = event.text;

          // a. Save history to D1
          try {
            const metadata: Record<string, unknown> = {
              primary_role: activeRole,
              collaborators: routing.collaborators,
              routing_reason: routing.reason,
              architecture: 'aichat_agent_ws',
              model_alias: modelAlias,
              model_route: 'main_model_with_delegate_tools',
              tools_used: Array.from(new Set(event.steps.flatMap((s) => s.toolCalls.map((t) => t.toolName)))),
              delegate_generate_used: event.steps.some((s) => s.toolCalls.some((t) => t.toolName === 'delegate_generate')),
            };

            await saveOrchestrateAssistantMessage(this.env.DB, userId, text, metadata);
          } catch { /* ignore save failure */ }

          // Notify AIChatAgent that stream is done (type assertion needed due to ToolSet variance)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await onFinish(event as any);
        },
      });

      return result.toUIMessageStreamResponse();
    } catch (error) {
      console.error('[SupervisorAgent] onChatMessage failed:', error);
      try {
        this.broadcastCustom({ type: 'status', message: '处理失败，请稍后重试。' });
      } catch {
        // ignore broadcast failure
      }
      const message = error instanceof Error && error.message
        ? error.message
        : '系统繁忙，请稍后重试';
      return textResponse(`[错误] ${message}`);
    }
  }

  // --- Helpers ---

  private broadcastCustom(payload: CustomBroadcast): void {
    this.broadcast(JSON.stringify(payload));
  }
}
