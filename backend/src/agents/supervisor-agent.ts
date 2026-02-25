import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { streamText, tool, convertToModelMessages, stepCountIs, type StreamTextOnFinishCallback, type ToolSet } from 'ai';
import type { Connection, ConnectionContext } from 'agents';
import { jwtVerify } from 'jose';
import type { AIRole } from '../../../shared/types';
import type { Bindings } from '../types';
import { getMainLLMModel, getRoleLLMModel } from '../services/ai-provider';
import { decideExecutionMode } from '../services/execution-mode';
import { syncProfileToolSchema } from './sync-profile-tool';
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
  resolveWritebackPayload,
  hasWritebackChanges,
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
 * 问题根因：
 *   sync_profile 工具设置了 needsApproval: true，AIChatAgent 会在
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
      const systemPrompt = SYSTEM_PROMPTS[activeRole] + '\n\n' + contextStr;
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
      this.broadcastCustom({ type: 'status', message: '主链路正在判定任务复杂度...' });
      const executionDecision = await decideExecutionMode(this.env, userText, hasImageInput);
      const useRoleModel = executionDecision.mode === 'role';
      const model = useRoleModel ? getRoleLLMModel(this.env) : getMainLLMModel(this.env);
      const modelAlias = useRoleModel ? 'LLM1' : 'LLM';
      this.broadcastCustom({
        type: 'status',
        message: useRoleModel
          ? `复杂任务：已切换深度模型处理（${executionDecision.reason}）`
          : `简单任务：主模型快速处理（${executionDecision.reason}）`,
      });

      // Track whether the sync_profile tool was executed
      let toolExecuted = false;

      const syncProfileTool = tool({
        description: '当识别到用户健康数据或记录类数据（体重、睡眠、伤病、训练目标、训练记录、饮食记录等）时调用，将数据同步到用户档案与记录表。请在回复完用户问题后调用。',
        inputSchema: syncProfileToolSchema,
        needsApproval: true,
        execute: async (args) => {
          toolExecuted = true;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { summary_text, ...writebackPayload } = args;
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
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : '档案同步失败';
            try {
              await recordWritebackAudit(this.env.DB, userId, 'orchestrate_stream', null, errMsg, userText);
            } catch { /* ignore */ }
            return { success: false, error: errMsg };
          }
        },
      });

      const result = streamText({
        model,
        system: systemPrompt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: await convertToModelMessages(trimmedConversation as any),
        tools: allowProfileSync ? { sync_profile: syncProfileTool } : {},
        stopWhen: allowProfileSync ? stepCountIs(2) : stepCountIs(1),
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
              model_route: useRoleModel ? 'complex_task' : 'simple_task',
              model_route_source: executionDecision.source,
            };

            await saveOrchestrateAssistantMessage(this.env.DB, userId, text, metadata);
          } catch { /* ignore save failure */ }

          // c. Fallback: if LLM did not call sync_profile, try rule-based writeback silently
          if (allowProfileSync && !toolExecuted) {
            try {
              const { payload: writebackPayload } = await resolveWritebackPayload(
                this.env,
                userText,
                history,
                text,
              );
              if (writebackPayload) {
                const summary = await applyAutoWriteback(this.env.DB, userId, writebackPayload, {
                  contextText: `${userText}\n${text}`,
                });
                if (hasWritebackChanges(summary)) {
                  const syncBroadcast: ProfileSyncResultBroadcast = {
                    type: 'profile_sync_result',
                    summary,
                  };
                  this.broadcastCustom(syncBroadcast);
                  try {
                    await recordWritebackAudit(this.env.DB, userId, 'orchestrate_stream', summary, null, userText);
                  } catch { /* ignore */ }
                }
              }
            } catch { /* silent fallback writeback failure */ }
          }

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
