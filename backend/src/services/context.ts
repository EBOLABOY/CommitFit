import type { D1Database } from '@cloudflare/workers-types';
type AIRole = 'doctor' | 'rehab' | 'nutritionist' | 'trainer';

type ChatRole = 'system' | 'user' | 'assistant';

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type ChatMessage = {
  role: ChatRole;
  content: string | ContentPart[];
};

interface UserContext {
  profile: Record<string, unknown> | null;
  healthMetrics: Record<string, unknown>[];
  conditions: Record<string, unknown>[];
  trainingGoals: Record<string, unknown>[];
  recentTraining: Record<string, unknown>[];
  recentNutrition: Record<string, unknown>[];
  recentDiet: Record<string, unknown>[];
  recentDailyLogs: Record<string, unknown>[];
}

const CONTEXT_HEALTH_LIMIT = 10;
const CONTEXT_TRAINING_LIMIT = 3;
const CONTEXT_NUTRITION_LIMIT = 3;
const CONTEXT_DIET_LIMIT = 3;
const CONTEXT_DAILY_LOG_LIMIT = 7;

export async function getUserContext(db: D1Database, userId: string): Promise<UserContext> {
  const [profile, healthMetrics, conditions, trainingGoals, recentTraining, recentNutrition, recentDiet, recentDailyLogs] = await Promise.all([
    db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first(),
    db.prepare('SELECT * FROM health_metrics WHERE user_id = ? ORDER BY recorded_at DESC LIMIT ?')
      .bind(userId, CONTEXT_HEALTH_LIMIT)
      .all(),
    db.prepare("SELECT * FROM conditions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC").bind(userId).all(),
    db.prepare("SELECT * FROM training_goals WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC").bind(userId).all(),
    db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY plan_date DESC LIMIT ?')
      .bind(userId, CONTEXT_TRAINING_LIMIT)
      .all(),
    db.prepare('SELECT * FROM nutrition_plans WHERE user_id = ? ORDER BY plan_date DESC LIMIT ?')
      .bind(userId, CONTEXT_NUTRITION_LIMIT)
      .all(),
    db.prepare('SELECT * FROM diet_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userId, CONTEXT_DIET_LIMIT)
      .all(),
    db.prepare('SELECT * FROM daily_logs WHERE user_id = ? ORDER BY log_date DESC LIMIT ?')
      .bind(userId, CONTEXT_DAILY_LOG_LIMIT)
      .all(),
  ]);

  return {
    profile: profile as Record<string, unknown> | null,
    healthMetrics: healthMetrics.results as Record<string, unknown>[],
    conditions: conditions.results as Record<string, unknown>[],
    trainingGoals: trainingGoals.results as Record<string, unknown>[],
    recentTraining: recentTraining.results as Record<string, unknown>[],
    recentNutrition: recentNutrition.results as Record<string, unknown>[],
    recentDiet: recentDiet.results as Record<string, unknown>[],
    recentDailyLogs: recentDailyLogs.results as Record<string, unknown>[],
  };
}

function toCompactJson(data: unknown, maxLength: number): string {
  const text = JSON.stringify(data);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(已截断)`;
}

export function buildContextForRole(role: AIRole, ctx: UserContext): string {
  const parts: string[] = [];

  const trainingGoalStr = ctx.trainingGoals.length > 0
    ? ctx.trainingGoals.map((g) => g.name).join('、')
    : '未设置';

  const profileStr = ctx.profile
    ? `身体基础数据：身高${ctx.profile.height || '未填'}cm，体重${ctx.profile.weight || '未填'}kg，出生日期${ctx.profile.birth_date || '未填'}，性别${ctx.profile.gender === 'male' ? '男' : ctx.profile.gender === 'female' ? '女' : '未填'}，训练目标：${trainingGoalStr}，训练年限${ctx.profile.training_years ?? '未填'}年`
    : '用户尚未填写身体基础数据。';

  switch (role) {
    case 'doctor':
      parts.push(profileStr);
      if (ctx.healthMetrics.length > 0) {
        parts.push('理化指标记录：' + toCompactJson(ctx.healthMetrics, 2400));
      }
      if (ctx.conditions.length > 0) {
        parts.push('伤病记录（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.conditions, 900));
      }
      if (ctx.trainingGoals.length > 0) {
        parts.push('训练目标（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.trainingGoals, 1400));
      }
      if (ctx.recentDailyLogs.length > 0) {
        parts.push('近期身体日志（体重/睡眠）：' + toCompactJson(ctx.recentDailyLogs, 1200));
      }
      break;

    case 'rehab':
      parts.push(profileStr);
      if (ctx.conditions.length > 0) {
        parts.push('当前伤病/外科问题：' + ctx.conditions.map((c) => `${c.name}(${c.severity || '未标注严重程度'}): ${c.description || '无详细描述'}`).join('；'));
        parts.push('伤病记录（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.conditions, 1600));
      }
      if (ctx.trainingGoals.length > 0) {
        parts.push('训练目标（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.trainingGoals, 1400));
      }
      if (ctx.healthMetrics.length > 0) {
        parts.push('相关理化指标：' + toCompactJson(ctx.healthMetrics, 1800));
      }
      if (ctx.recentDailyLogs.length > 0) {
        parts.push('近期身体日志（体重/睡眠）：' + toCompactJson(ctx.recentDailyLogs, 900));
      }
      break;

    case 'nutritionist':
      parts.push(profileStr);
      if (ctx.healthMetrics.length > 0) {
        parts.push('理化指标：' + toCompactJson(ctx.healthMetrics, 1400));
      }
      if (ctx.trainingGoals.length > 0) {
        parts.push('训练目标（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.trainingGoals, 1200));
      }
      if (ctx.recentTraining.length > 0) {
        parts.push('近期训练计划：' + toCompactJson(ctx.recentTraining, 1200));
      }
      if (ctx.conditions.length > 0) {
        parts.push('伤病情况：' + ctx.conditions.map((c) => `${c.name}`).join('、'));
        parts.push('伤病记录（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.conditions, 900));
      }
      if (ctx.recentDiet.length > 0) {
        parts.push('近期饮食记录：' + toCompactJson(ctx.recentDiet, 1200));
      }
      if (ctx.recentDailyLogs.length > 0) {
        parts.push('近期身体日志（体重/睡眠）：' + toCompactJson(ctx.recentDailyLogs, 900));
      }
      break;

    case 'trainer':
      parts.push(profileStr);
      if (ctx.healthMetrics.length > 0) {
        parts.push('理化指标：' + toCompactJson(ctx.healthMetrics, 1400));
      }
      if (ctx.trainingGoals.length > 0) {
        parts.push('训练目标（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.trainingGoals, 1400));
      }
      if (ctx.conditions.length > 0) {
        parts.push('伤病情况：' + ctx.conditions.map((c) => `${c.name}(${c.severity || ''}${c.status === 'recovered' ? '，已恢复' : ''}): ${c.description || ''}`).join('；'));
        parts.push('伤病记录（含 id，供 AI 修改/删除用）：' + toCompactJson(ctx.conditions, 1600));
      }
      if (ctx.recentNutrition.length > 0) {
        parts.push('近期营养方案：' + toCompactJson(ctx.recentNutrition, 1200));
      }
      if (ctx.recentTraining.length > 0) {
        parts.push('历史训练计划：' + toCompactJson(ctx.recentTraining, 1200));
      }
      if (ctx.recentDailyLogs.length > 0) {
        parts.push('近期身体日志（体重/睡眠）：' + toCompactJson(ctx.recentDailyLogs, 900));
      }
      break;
  }

  return parts.join('\n\n');
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = Math.max(0, text.length - chineseChars);
  return Math.ceil(chineseChars * 2 + otherChars / 4);
}

function estimateContentTokens(content: string | ContentPart[]): number {
  if (typeof content === 'string') return estimateTokens(content);
  let tokens = 0;
  for (const part of content) {
    if (part.type === 'text') tokens += estimateTokens(part.text);
    else tokens += 85; // fixed estimate for image tokens
  }
  return tokens;
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, msg) => total + estimateContentTokens(msg.content) + 4, 0);
}

function trimTextByTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = Math.max(200, maxTokens * 2);
  return `${text.slice(0, maxChars)}...(上下文已截断)`;
}

type TrimOptions = {
  maxSystemTokens: number;
  maxHistoryTokens: number;
  totalTokens: number;
};

export function trimMessages(
  messages: ChatMessage[],
  options: TrimOptions
): ChatMessage[] {
  if (messages.length <= 2) {
    return messages;
  }

  const [systemMessage, ...restMessages] = messages;
  const currentUserMessage = restMessages[restMessages.length - 1];
  const historyMessages = restMessages.slice(0, -1);

  const trimmedSystem: ChatMessage = {
    role: systemMessage.role,
    content: trimTextByTokenBudget(typeof systemMessage.content === 'string' ? systemMessage.content : '', options.maxSystemTokens),
  };

  let trimmedHistory = [...historyMessages];
  while (estimateMessagesTokens(trimmedHistory) > options.maxHistoryTokens && trimmedHistory.length > 0) {
    trimmedHistory.shift();
  }

  let output = [trimmedSystem, ...trimmedHistory, currentUserMessage];
  while (estimateMessagesTokens(output) > options.totalTokens && trimmedHistory.length > 0) {
    trimmedHistory.shift();
    output = [trimmedSystem, ...trimmedHistory, currentUserMessage];
  }

  return output;
}

export async function getChatHistory(
  db: D1Database,
  userId: string,
  role: AIRole,
  limit = 20
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { results } = await db
    .prepare(
      'SELECT message_role, content FROM chat_history WHERE user_id = ? AND role = ? ORDER BY created_at DESC LIMIT ?'
    )
    .bind(userId, role, limit)
    .all<{ message_role: string; content: string }>();

  return results
    .reverse()
    .map((r) => ({ role: r.message_role as 'user' | 'assistant', content: r.content }));
}
