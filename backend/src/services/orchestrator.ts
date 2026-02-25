import type { D1Database } from '@cloudflare/workers-types';
import type { Bindings } from '../types';
import { callLLMNonStream } from './llm';
import { buildContextForRole, getUserContext, trimMessages } from './context';
import { DOCTOR_SYSTEM_PROMPT } from '../prompts/doctor';
import { REHAB_SYSTEM_PROMPT } from '../prompts/rehab';
import { NUTRITIONIST_SYSTEM_PROMPT } from '../prompts/nutritionist';
import { TRAINER_SYSTEM_PROMPT } from '../prompts/trainer';
import { isISODateString } from '../utils/validate';

export type AIRole = 'doctor' | 'rehab' | 'nutritionist' | 'trainer';
export type OrchestrateRole = AIRole | 'orchestrator';

export interface OrchestrateHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OrchestrateAutoWriteSummary {
  profile_updated: boolean;
  conditions_upserted: number;
  training_goals_upserted: number;
  health_metrics_created: number;
  training_plan_created: boolean;
  nutrition_plan_created: boolean;
  supplement_plan_created: boolean;
  diet_records_created: number;
  daily_log_upserted: boolean;
}

export interface OrchestrateResult {
  answer: string;
  primary_role: AIRole;
  collaborators: AIRole[];
  routing_reason: string;
  auto_writeback: boolean;
  updates: OrchestrateAutoWriteSummary;
}

interface OrchestrateParams {
  env: Bindings;
  userId: string;
  message: string;
  history: OrchestrateHistoryMessage[];
  imageDataUri: string | null;
  imageUrl: string | null;
  autoWriteback: boolean;
}

interface RouteDecision {
  primaryRole: AIRole;
  collaborators: AIRole[];
  reason: string;
}

type Gender = 'male' | 'female';
type Severity = 'mild' | 'moderate' | 'severe';
type ConditionStatus = 'active' | 'recovered';
type TrainingGoalStatus = 'active' | 'completed';
type TrainingGoalsWriteMode = 'upsert' | 'replace_all' | 'clear_all';
type MetricType = 'testosterone' | 'blood_pressure' | 'blood_lipids' | 'blood_sugar' | 'heart_rate' | 'body_fat' | 'other';
type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
type SleepQuality = 'good' | 'fair' | 'poor';

interface ExtractedProfilePatch {
  height?: number | null;
  weight?: number | null;
  birth_date?: string | null;
  gender?: Gender | null;
  training_goal?: string | null;
  training_years?: number | null;
}

interface ExtractedCondition {
  name?: string;
  description?: string | null;
  severity?: Severity | null;
  status?: ConditionStatus | null;
}

interface ExtractedTrainingGoal {
  name?: string;
  description?: string | null;
  status?: TrainingGoalStatus | null;
}

interface ExtractedMetric {
  metric_type?: MetricType;
  value?: unknown;
  unit?: string | null;
  recorded_at?: string | null;
}

interface ExtractedPlan {
  content?: string;
  plan_date?: string;
}

interface ExtractedTrainingPlan {
  content?: string;
  plan_date?: string | null;
  notes?: string | null;
  completed?: boolean | number | null;
}

interface ExtractedDietRecord {
  meal_type?: MealType;
  record_date?: string | null;
  food_description?: string;
  foods_json?: unknown;
  calories?: number | null;
  protein?: number | null;
  fat?: number | null;
  carbs?: number | null;
  image_key?: string | null;
}

interface ExtractedDailyLog {
  log_date?: string | null;
  weight?: number | null;
  sleep_hours?: number | null;
  sleep_quality?: SleepQuality | null;
  note?: string | null;
}

interface ExtractedWritebackPayload {
  profile?: ExtractedProfilePatch;
  conditions?: ExtractedCondition[];
  training_goals?: ExtractedTrainingGoal[];
  training_goals_mode?: TrainingGoalsWriteMode | null;
  health_metrics?: ExtractedMetric[];
  training_plan?: ExtractedTrainingPlan | null;
  nutrition_plan?: ExtractedPlan | null;
  supplement_plan?: ExtractedPlan | null;
  diet_records?: ExtractedDietRecord[];
  daily_log?: ExtractedDailyLog | null;
}

export const SYSTEM_PROMPTS: Record<AIRole, string> = {
  doctor: DOCTOR_SYSTEM_PROMPT,
  rehab: REHAB_SYSTEM_PROMPT,
  nutritionist: NUTRITIONIST_SYSTEM_PROMPT,
  trainer: TRAINER_SYSTEM_PROMPT,
};

export const ROLE_NAMES: Record<AIRole, string> = {
  doctor: '运动医生',
  rehab: '康复师',
  nutritionist: '营养师',
  trainer: '私人教练',
};

const ROLE_KEYWORDS: Record<AIRole, string[]> = {
  doctor: ['体检', '指标', '血压', '血糖', '血脂', '睾酮', '心率', '医学', '风险', '异常', '化验'],
  rehab: ['疼痛', '受伤', '伤病', '康复', '拉伤', '扭伤', '膝盖', '腰', '肩', '术后', '复发'],
  nutritionist: ['营养', '饮食', '热量', '蛋白质', '碳水', '脂肪', '补剂', '蛋白粉', '肌酸', '食谱', '减脂', '增肌餐'],
  trainer: ['训练', '动作', '组数', '次数', '计划', '私教', '力量', '有氧', '深蹲', '卧推', '硬拉'],
};
const STRONG_NUTRITION_KEYWORDS = [
  '补剂',
  '蛋白粉',
  '肌酸',
  '鱼油',
  '维生素',
  '营养',
  '饮食',
  '热量',
  '蛋白质',
  '碳水',
  '脂肪',
  '早餐',
  '午餐',
  '晚餐',
  '练前',
  '练后',
  '睡前',
];

const VALID_ROLES: AIRole[] = ['doctor', 'rehab', 'nutritionist', 'trainer'];
const VALID_GENDER: Gender[] = ['male', 'female'];
const VALID_SEVERITY: Severity[] = ['mild', 'moderate', 'severe'];
const VALID_STATUS: ConditionStatus[] = ['active', 'recovered'];
const VALID_TRAINING_GOAL_STATUS: TrainingGoalStatus[] = ['active', 'completed'];
const VALID_TRAINING_GOAL_WRITE_MODES: TrainingGoalsWriteMode[] = ['upsert', 'replace_all', 'clear_all'];
const VALID_METRIC_TYPES: MetricType[] = ['testosterone', 'blood_pressure', 'blood_lipids', 'blood_sugar', 'heart_rate', 'body_fat', 'other'];
const VALID_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const VALID_SLEEP_QUALITIES: SleepQuality[] = ['good', 'fair', 'poor'];

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_HISTORY_MESSAGES = 16;

function asDateOnly(input: string | undefined): string {
  if (input && DATE_ONLY_REGEX.test(input)) return input;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateOnly: string, offsetDays: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getWeekMonday(dateOnly: string): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function inferTrainingPlanDate(rawPlanDate: unknown, sourceText: string): string {
  if (typeof rawPlanDate === 'string' && DATE_ONLY_REGEX.test(rawPlanDate)) {
    return rawPlanDate;
  }

  const explicitDate = sourceText.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (explicitDate && DATE_ONLY_REGEX.test(explicitDate)) {
    return explicitDate;
  }

  const today = asDateOnly(undefined);
  if (/(后天)/.test(sourceText)) return addDays(today, 2);
  if (/(明天|明日)/.test(sourceText)) return addDays(today, 1);
  if (/(本周|一周|7天|七天|周计划)/.test(sourceText)) return getWeekMonday(today);
  if (/(今天|今日)/.test(sourceText)) return today;

  return today;
}

function inferRecordDate(rawDate: unknown, sourceText: string): string {
  if (typeof rawDate === 'string' && DATE_ONLY_REGEX.test(rawDate)) {
    return rawDate;
  }
  const explicitDate = sourceText.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (explicitDate && DATE_ONLY_REGEX.test(explicitDate)) {
    return explicitDate;
  }

  const today = asDateOnly(undefined);
  if (/(昨天|昨日)/.test(sourceText)) return addDays(today, -1);
  if (/(前天)/.test(sourceText)) return addDays(today, -2);
  if (/(后天)/.test(sourceText)) return addDays(today, 2);
  if (/(明天|明日)/.test(sourceText)) return addDays(today, 1);
  return today;
}

function normalizeString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function normalizeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function normalizeTrainingGoalsMode(value: unknown): TrainingGoalsWriteMode | null {
  if (typeof value !== 'string') return null;
  return VALID_TRAINING_GOAL_WRITE_MODES.includes(value as TrainingGoalsWriteMode)
    ? (value as TrainingGoalsWriteMode)
    : null;
}

function isMeaningfulTrainingGoalName(name: string): boolean {
  const compact = name
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?,.；;:：“”"'`（）()【】\[\]{}<>]/g, '');

  if (compact.length < 2) return false;
  if (
    /^(好|好的|ok|okay|yes|明白|收到|了解|知道了|可以|行|嗯|完成|done|已完成|已删除|已清空)$/.test(compact)
  ) {
    return false;
  }
  if (/(清空|删除|移除|重置|取消)(目标)?$/.test(compact)) return false;
  return true;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenceMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of fenceMatches) {
    if (m[1]) candidates.push(m[1].trim());
  }
  candidates.push(text.trim());

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    const source = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
    try {
      const parsed = JSON.parse(source);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }

  return null;
}

function scoreRoleByKeyword(text: string): Record<AIRole, number> {
  const normalized = text.toLowerCase();
  const scores: Record<AIRole, number> = { doctor: 0, rehab: 0, nutritionist: 0, trainer: 0 };
  for (const role of VALID_ROLES) {
    let score = 0;
    for (const keyword of ROLE_KEYWORDS[role]) {
      if (normalized.includes(keyword.toLowerCase())) score += 1;
    }
    scores[role] = score;
  }
  return scores;
}

export function chooseByKeyword(message: string, history: OrchestrateHistoryMessage[]): RouteDecision | null {
  const normalizedMessage = message.toLowerCase();
  const hasStrongNutritionIntent = STRONG_NUTRITION_KEYWORDS.some((keyword) =>
    normalizedMessage.includes(keyword.toLowerCase())
  );
  if (hasStrongNutritionIntent) {
    const needTrainerAssist = ROLE_KEYWORDS.trainer.some((keyword) =>
      normalizedMessage.includes(keyword.toLowerCase())
    );
    return {
      primaryRole: 'nutritionist',
      collaborators: needTrainerAssist ? ['trainer'] : [],
      reason: '强规则路由：营养/补剂问题优先营养师',
    };
  }

  const joinedHistory = history.slice(-6).map((h) => h.content).join('\n');
  const scores = scoreRoleByKeyword(`${message}\n${joinedHistory}`);
  const ranked = [...VALID_ROLES]
    .map((role) => ({ role, score: scores[role] }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0].score <= 0) {
    return null;
  }

  const primaryRole = ranked[0].role;
  const collaborators = ranked
    .slice(1)
    .filter((item) => item.score >= Math.max(1, ranked[0].score - 1))
    .map((item) => item.role)
    .slice(0, 2);

  return {
    primaryRole,
    collaborators,
    reason: `关键词路由：${ROLE_NAMES[primaryRole]}`,
  };
}

async function chooseByLLM(
  env: Bindings,
  message: string,
  history: OrchestrateHistoryMessage[]
): Promise<RouteDecision | null> {
  const recentHistory = history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? '用户' : '助手'}: ${item.content}`)
    .join('\n');

  const prompt = [
    '你是健身咨询路由器。根据用户问题，选择主答角色，并可选 0-2 个协作角色。',
    '可选角色：doctor, rehab, nutritionist, trainer。',
    '输出必须是 JSON，且只输出 JSON：',
    '{"primary_role":"trainer","collaborators":["nutritionist"],"reason":"一句话理由"}',
    '',
    `用户问题：${message}`,
    recentHistory ? `近期对话：\n${recentHistory}` : '近期对话：无',
  ].join('\n');

  const response = await callLLMNonStream({
    env,
    messages: [
      { role: 'system', content: '你是严格的 JSON 路由器。禁止输出 JSON 以外内容。' },
      { role: 'user', content: prompt },
    ],
    timeoutMs: 30_000,
    maxAttempts: 1,
  });

  const obj = extractJsonObject(response);
  if (!obj) return null;

  const primaryRole = obj.primary_role;
  const collaboratorsRaw = obj.collaborators;
  const reasonText = normalizeString(obj.reason, 120) || 'LLM 路由';

  if (typeof primaryRole !== 'string' || !VALID_ROLES.includes(primaryRole as AIRole)) {
    return null;
  }

  const collaborators = Array.isArray(collaboratorsRaw)
    ? collaboratorsRaw
        .filter((item): item is string => typeof item === 'string')
        .filter((item): item is AIRole => VALID_ROLES.includes(item as AIRole))
        .filter((item) => item !== primaryRole)
        .slice(0, 2)
    : [];

  return {
    primaryRole: primaryRole as AIRole,
    collaborators,
    reason: reasonText,
  };
}

export async function decideRoute(
  env: Bindings,
  message: string,
  history: OrchestrateHistoryMessage[]
): Promise<RouteDecision> {
  const byKeyword = chooseByKeyword(message, history);
  if (byKeyword) return byKeyword;

  try {
    const byLLM = await chooseByLLM(env, message, history);
    if (byLLM) return byLLM;
  } catch {
    // ignore and use fallback
  }

  return {
    primaryRole: 'trainer',
    collaborators: [],
    reason: '兜底路由：私人教练',
  };
}

async function generatePrimaryAnswer(
  env: Bindings,
  primaryRole: AIRole,
  userContext: Awaited<ReturnType<typeof getUserContext>>,
  history: OrchestrateHistoryMessage[],
  message: string,
  imageDataUri: string | null
): Promise<string> {
  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };
  const currentUserContent: string | ContentPart[] = imageDataUri
    ? [
        { type: 'image_url' as const, image_url: { url: imageDataUri } },
        { type: 'text' as const, text: message },
      ]
    : message;

  const context = buildContextForRole(primaryRole, userContext);
  const systemPrompt = SYSTEM_PROMPTS[primaryRole] + '\n\n' + context;

  const normalizedHistory = history
    .filter((item) => item.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({ role: item.role, content: item.content }));

  const messages = trimMessages(
    [
      { role: 'system' as const, content: systemPrompt },
      ...normalizedHistory,
      { role: 'user' as const, content: currentUserContent },
    ],
    {
      maxSystemTokens: 8000,
      maxHistoryTokens: 4000,
      totalTokens: 12000,
    }
  );

  return callLLMNonStream({ env, messages, timeoutMs: 60_000 });
}

export async function generateCollaboratorSupplements(
  env: Bindings,
  collaborators: AIRole[],
  userContext: Awaited<ReturnType<typeof getUserContext>>,
  userMessage: string,
  primaryRole: AIRole,
  primaryAnswer: string
): Promise<Array<{ role: AIRole; content: string }>> {
  if (collaborators.length === 0) return [];

  const results = await Promise.all(
    collaborators.map(async (role) => {
      const prompt = [
        `主答角色：${ROLE_NAMES[primaryRole]}`,
        `用户问题：${userMessage}`,
        `主答内容：${primaryAnswer}`,
        '',
        '请从你的专业角度补充 2-4 条可执行建议，避免重复主答。',
        '输出纯文本，不要 JSON，不要前缀解释。',
      ].join('\n');

      const answer = await callLLMNonStream({
        env,
        messages: [
          { role: 'system', content: SYSTEM_PROMPTS[role] + '\n\n' + buildContextForRole(role, userContext) },
          { role: 'user', content: prompt },
        ],
        timeoutMs: 45_000,
      });

      return { role, content: answer.trim() };
    })
  );

  return results.filter((item) => item.content.length > 0);
}

export function composeFinalAnswer(primaryRole: AIRole, primaryAnswer: string, supplements: Array<{ role: AIRole; content: string }>): string {
  const main = primaryAnswer.trim();
  if (supplements.length === 0) return main;

  const supplementText = supplements
    .map((item) => `【${ROLE_NAMES[item.role]}补充】\n${item.content}`)
    .join('\n\n');

  return `${main}\n\n---\n会诊补充\n${supplementText}`;
}

export async function extractWritebackPayload(
  env: Bindings,
  message: string,
  history: OrchestrateHistoryMessage[],
  answer: string
): Promise<ExtractedWritebackPayload | null> {
  const historyText = history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? '用户' : '助手'}: ${item.content}`)
    .join('\n');

  const prompt = [
    '你是结构化信息提取器。根据输入内容抽取可写回数据。',
    '仅在信息明确时填写；不明确请填 null 或空数组；禁止臆造。',
    '当用户明确要求清空训练目标时，设置 training_goals_mode="clear_all"；若是“先清空再设置新目标”，设置 training_goals_mode="replace_all" 并填充 training_goals。',
    '训练目标必须从【用户最新问题/近期对话】中抽取，不要把【最终答复】里的确认语或客套话写入 training_goals。',
    '当用户提供多个训练目标（例如 1./2./3. 分段标题），请将每一段写成一个 training_goals 元素：name=标题，description=该段完整内容（可多行）。',
    '训练计划（training_plan.content）通常来自【最终答复】中的计划正文。',
    '必须只输出 JSON，不要 markdown，不要解释。',
    'JSON 模板：',
    '{"profile":{"height":null,"weight":null,"birth_date":null,"gender":null,"training_goal":null,"training_years":null},"conditions":[{"name":"","description":null,"severity":null,"status":"active"}],"training_goals":[{"name":"","description":null,"status":"active"}],"training_goals_mode":"upsert","health_metrics":[{"metric_type":"other","value":"","unit":null,"recorded_at":null}],"training_plan":{"content":"","plan_date":null,"notes":null,"completed":false},"nutrition_plan":{"content":"","plan_date":null},"supplement_plan":{"content":"","plan_date":null},"diet_records":[{"meal_type":"lunch","record_date":null,"food_description":"","foods_json":null,"calories":null,"protein":null,"fat":null,"carbs":null,"image_key":null}],"daily_log":{"log_date":null,"weight":null,"sleep_hours":null,"sleep_quality":null,"note":null}}',
    '',
    `用户最新问题：${message}`,
    historyText ? `近期对话：\n${historyText}` : '近期对话：无',
    `最终答复：${answer}`,
  ].join('\n');

  const raw = await callLLMNonStream({
    env,
    messages: [
      { role: 'system', content: '你只输出严格 JSON。' },
      { role: 'user', content: prompt },
    ],
    timeoutMs: 40_000,
    maxAttempts: 1,
  });

  const obj = extractJsonObject(raw);
  if (!obj) return null;
  return obj as unknown as ExtractedWritebackPayload;
}

function getTrainingGoalMergeKey(name: string): string {
  const compact = name.trim().toLowerCase().replace(/\s+/g, '');
  if (!compact) return '';

  if (/(增肌|增重|长肌|肌肉增长|肌肥大)/.test(compact)) return 'goal:muscle_gain';
  if (/(减脂|减重|减肥|瘦身|降脂|控脂)/.test(compact)) return 'goal:fat_loss';
  if (/(力量|爆发力|最大力量|卧推|深蹲|硬拉)/.test(compact)) return 'goal:strength';
  if (/(耐力|有氧|心肺|跑步|马拉松)/.test(compact)) return 'goal:endurance';
  if (/(康复|恢复|伤病|疼痛缓解)/.test(compact)) return 'goal:rehab';
  if (/(体态|柔韧|灵活|活动度)/.test(compact)) return 'goal:mobility';

  return `goal:${compact}`;
}

function looksLikeTrainingPlanText(text: string): boolean {
  const normalized = text.toLowerCase();
  const hasPlanKeyword = /(训练计划|周计划|今日训练|明日训练|热身|正式训练|静态放松|动作|组数|次数|rpe)/i.test(text);
  const hasStructuredHeading = /^##\s+/m.test(text) || /^###\s+/m.test(text);
  const hasSetRepPattern = /(\d+\s*[x×*]\s*\d+|\d+\s*组|\d+\s*次)/i.test(normalized);
  return hasPlanKeyword && (hasStructuredHeading || hasSetRepPattern);
}

function inferMealTypeFromText(text: string): MealType | null {
  if (/(早餐|早饭|早晨)/.test(text)) return 'breakfast';
  if (/(午餐|午饭|中饭)/.test(text)) return 'lunch';
  if (/(晚餐|晚饭|晚食)/.test(text)) return 'dinner';
  if (/(加餐|零食|夜宵)/.test(text)) return 'snack';
  return null;
}

function hasMeaningfulObjectValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some((item) => {
    if (item === undefined || item === null) return false;
    if (typeof item === 'string') return item.trim().length > 0;
    return true;
  });
}

function normalizeWritebackPayload(payload: ExtractedWritebackPayload | null | undefined): ExtractedWritebackPayload | null {
  if (!payload) return null;
  const normalized: ExtractedWritebackPayload = {};
  const trainingGoalsMode = normalizeTrainingGoalsMode(payload.training_goals_mode);

  if (hasMeaningfulObjectValue(payload.profile)) normalized.profile = payload.profile;
  if (Array.isArray(payload.conditions) && payload.conditions.length > 0) normalized.conditions = payload.conditions;
  if (Array.isArray(payload.training_goals) && payload.training_goals.length > 0) {
    normalized.training_goals = payload.training_goals;
    normalized.training_goals_mode = trainingGoalsMode ?? 'upsert';
  } else if (trainingGoalsMode) {
    normalized.training_goals_mode = trainingGoalsMode;
  }
  if (Array.isArray(payload.health_metrics) && payload.health_metrics.length > 0) normalized.health_metrics = payload.health_metrics;
  if (hasMeaningfulObjectValue(payload.training_plan)) normalized.training_plan = payload.training_plan;
  if (hasMeaningfulObjectValue(payload.nutrition_plan)) normalized.nutrition_plan = payload.nutrition_plan;
  if (hasMeaningfulObjectValue(payload.supplement_plan)) normalized.supplement_plan = payload.supplement_plan;
  if (Array.isArray(payload.diet_records) && payload.diet_records.length > 0) normalized.diet_records = payload.diet_records;
  if (hasMeaningfulObjectValue(payload.daily_log)) normalized.daily_log = payload.daily_log;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function hasWritebackChanges(summary: OrchestrateAutoWriteSummary): boolean {
  return Boolean(
    summary.profile_updated ||
    summary.conditions_upserted > 0 ||
    summary.training_goals_upserted > 0 ||
    summary.health_metrics_created > 0 ||
    summary.training_plan_created ||
    summary.nutrition_plan_created ||
    summary.supplement_plan_created ||
    summary.diet_records_created > 0 ||
    summary.daily_log_upserted
  );
}

export async function resolveWritebackPayload(
  env: Bindings,
  message: string,
  history: OrchestrateHistoryMessage[],
  answer: string
): Promise<{
  payload: ExtractedWritebackPayload | null;
  extractionError: string | null;
  fallbackUsed: boolean;
}> {
  let llmPayload: ExtractedWritebackPayload | null = null;
  let extractionError: string | null = null;

  try {
    llmPayload = await extractWritebackPayload(env, message, history, answer);
  } catch (error) {
    extractionError = error instanceof Error ? error.message : '结构化提取失败';
  }

  return {
    payload: normalizeWritebackPayload(llmPayload),
    extractionError,
    fallbackUsed: false,
  };
}

async function applyProfilePatch(db: D1Database, userId: string, patch: ExtractedProfilePatch | undefined): Promise<boolean> {
  if (!patch || typeof patch !== 'object') return false;
  const fields: string[] = [];
  const values: unknown[] = [];

  if (typeof patch.height === 'number' && Number.isFinite(patch.height) && patch.height >= 50 && patch.height <= 300) {
    fields.push('height = ?');
    values.push(patch.height);
  }
  if (typeof patch.weight === 'number' && Number.isFinite(patch.weight) && patch.weight >= 20 && patch.weight <= 500) {
    fields.push('weight = ?');
    values.push(patch.weight);
  }
  if (typeof patch.birth_date === 'string' && DATE_ONLY_REGEX.test(patch.birth_date)) {
    fields.push('birth_date = ?');
    values.push(patch.birth_date);
  }
  if (typeof patch.gender === 'string' && VALID_GENDER.includes(patch.gender as Gender)) {
    fields.push('gender = ?');
    values.push(patch.gender);
  }
  if (
    typeof patch.training_years === 'number' &&
    Number.isFinite(patch.training_years) &&
    patch.training_years >= 0 &&
    patch.training_years <= 80
  ) {
    fields.push('training_years = ?');
    values.push(Number(patch.training_years.toFixed(1)));
  }
  if (typeof patch.training_goal === 'string') {
    const trainingGoal = normalizeString(patch.training_goal, 200);
    if (trainingGoal) {
      fields.push('training_goal = ?');
      values.push(trainingGoal);
    }
  }

  if (fields.length === 0) return false;
  await db.prepare('INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)').bind(userId).run();
  fields.push("updated_at = datetime('now')");
  await db.prepare(`UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = ?`)
    .bind(...values, userId)
    .run();
  return true;
}

async function applyConditions(db: D1Database, userId: string, rawConditions: ExtractedCondition[] | undefined): Promise<number> {
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) return 0;
  const seen = new Set<string>();
  let upserted = 0;

  for (const item of rawConditions.slice(0, 5)) {
    const name = normalizeString(item?.name, 100);
    if (!name) continue;
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const description = item?.description == null ? null : normalizeString(item.description, 500);
    const severity = typeof item?.severity === 'string' && VALID_SEVERITY.includes(item.severity as Severity)
      ? item.severity
      : null;
    const status = typeof item?.status === 'string' && VALID_STATUS.includes(item.status as ConditionStatus)
      ? item.status
      : 'active';

    const existing = await db.prepare(
      'SELECT id FROM conditions WHERE user_id = ? AND lower(name) = lower(?) LIMIT 1'
    )
      .bind(userId, name)
      .first<{ id: string }>();

    if (existing?.id) {
      await db.prepare(
        'UPDATE conditions SET description = ?, severity = ?, status = ? WHERE id = ? AND user_id = ?'
      )
        .bind(description, severity, status, existing.id, userId)
        .run();
    } else {
      const id = crypto.randomUUID();
      await db.prepare(
        'INSERT INTO conditions (id, user_id, name, description, severity, status) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, userId, name, description, severity, status)
        .run();
    }

    upserted += 1;
  }

  return upserted;
}

async function applyTrainingGoals(
  db: D1Database,
  userId: string,
  rawGoals: ExtractedTrainingGoal[] | undefined,
  mode: TrainingGoalsWriteMode | null | undefined
): Promise<number> {
  const normalizedMode: TrainingGoalsWriteMode = normalizeTrainingGoalsMode(mode) ?? 'upsert';
  const seen = new Set<string>();
  const candidates: Array<{
    name: string;
    dedupeKey: string;
    description: string | null;
    status: TrainingGoalStatus | null;
  }> = [];

  for (const item of (Array.isArray(rawGoals) ? rawGoals : []).slice(0, 5)) {
    const name = normalizeString(item?.name, 100);
    if (!name) continue;
    if (!isMeaningfulTrainingGoalName(name)) continue;
    const dedupeKey = getTrainingGoalMergeKey(name);
    if (!dedupeKey) continue;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const description = item?.description == null ? null : normalizeString(item.description, 4000);
    const status = typeof item?.status === 'string' && VALID_TRAINING_GOAL_STATUS.includes(item.status as TrainingGoalStatus)
      ? (item.status as TrainingGoalStatus)
      : null;
    candidates.push({ name, dedupeKey, description, status });
  }

  const existingCountRow = await db.prepare(
    'SELECT COUNT(1) as total FROM training_goals WHERE user_id = ?'
  ).bind(userId).first<{ total: number | string | null }>();
  const existingCount = Number(existingCountRow?.total ?? 0);

  if (normalizedMode === 'clear_all') {
    if (existingCount <= 0) return 0;
    await db.prepare('DELETE FROM training_goals WHERE user_id = ?').bind(userId).run();
    return existingCount;
  }

  if (normalizedMode === 'replace_all') {
    const statements = [db.prepare('DELETE FROM training_goals WHERE user_id = ?').bind(userId)];
    for (const item of candidates) {
      const id = crypto.randomUUID();
      statements.push(
        db.prepare(
          'INSERT INTO training_goals (id, user_id, name, description, status) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, userId, item.name, item.description, item.status || 'active')
      );
    }
    await db.batch(statements);
    if (candidates.length > 0) return candidates.length;
    return existingCount;
  }

  if (candidates.length === 0) return 0;
  let upserted = 0;

  const existingGoalsResult = await db.prepare(
    'SELECT id, name FROM training_goals WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<{ id: string; name: string }>();
  const existingByKey = new Map<string, { id: string }>();
  for (const row of existingGoalsResult.results || []) {
    if (!row?.id || !row?.name) continue;
    const key = getTrainingGoalMergeKey(row.name);
    if (!key) continue;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, { id: row.id });
    }
  }

  for (const item of candidates) {
    const existing = existingByKey.get(item.dedupeKey) || null;

    if (existing) {
      await db.prepare(
        'UPDATE training_goals SET name = ?, description = COALESCE(?, description), status = COALESCE(?, status) WHERE id = ? AND user_id = ?'
      )
        .bind(item.name, item.description, item.status, existing.id, userId)
        .run();
    } else {
      const id = crypto.randomUUID();
      await db.prepare(
        'INSERT INTO training_goals (id, user_id, name, description, status) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(id, userId, item.name, item.description, item.status || 'active')
        .run();
      existingByKey.set(item.dedupeKey, { id });
    }

    upserted += 1;
  }

  return upserted;
}

async function applyHealthMetrics(db: D1Database, userId: string, rawMetrics: ExtractedMetric[] | undefined): Promise<number> {
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) return 0;
  let created = 0;

  for (const item of rawMetrics.slice(0, 6)) {
    if (!item || typeof item !== 'object') continue;
    const metricType = item.metric_type;
    if (typeof metricType !== 'string' || !VALID_METRIC_TYPES.includes(metricType as MetricType)) continue;

    let valueText: string | null = null;
    if (typeof item.value === 'string') {
      valueText = normalizeString(item.value, 500);
    } else if (item.value !== undefined && item.value !== null) {
      try {
        valueText = normalizeString(JSON.stringify(item.value), 500);
      } catch {
        valueText = null;
      }
    }
    if (!valueText) continue;

    const unit = item.unit == null ? null : normalizeString(item.unit, 20);
    const recordedAt = typeof item.recorded_at === 'string' && isISODateString(item.recorded_at)
      ? item.recorded_at
      : null;

    const id = crypto.randomUUID();
    await db.prepare(
      'INSERT INTO health_metrics (id, user_id, metric_type, value, unit, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(id, userId, metricType, valueText, unit, recordedAt)
      .run();

    created += 1;
  }

  return created;
}

async function applyTrainingPlan(
  db: D1Database,
  userId: string,
  plan: ExtractedTrainingPlan | null | undefined,
  contextText?: string
): Promise<boolean> {
  if (!plan || typeof plan !== 'object') return false;

  const content = normalizeString(plan.content, 12000);
  if (!content || content.length < 12) return false;

  const planDate = inferTrainingPlanDate(plan.plan_date, `${contextText || ''}\n${content}`);
  const notes = plan.notes == null ? null : normalizeString(plan.notes, 500);
  const completed = plan.completed === true || plan.completed === 1 ? 1 : 0;

  // 同一天只保留一份计划，遵循 /api/training 的行为
  await db.prepare('DELETE FROM training_plans WHERE user_id = ? AND plan_date = ?')
    .bind(userId, planDate)
    .run();

  const id = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO training_plans (id, user_id, plan_date, content, completed, notes) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, planDate, content, completed, notes)
    .run();

  return true;
}

async function applyDietRecords(
  db: D1Database,
  userId: string,
  rawRecords: ExtractedDietRecord[] | undefined,
  contextText?: string
): Promise<number> {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) return 0;

  let created = 0;
  const seen = new Set<string>();

  for (const item of rawRecords.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;

    const mealType =
      typeof item.meal_type === 'string' && VALID_MEAL_TYPES.includes(item.meal_type as MealType)
        ? (item.meal_type as MealType)
        : null;
    if (!mealType) continue;

    const foodDescription = normalizeString(item.food_description, 1000);
    if (!foodDescription) continue;
    const recordDate = inferRecordDate(item.record_date, `${contextText || ''}\n${foodDescription}`);

    const dedupeKey = `${mealType}|${recordDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let foodsJson: string | null = null;
    if (typeof item.foods_json === 'string') {
      foodsJson = normalizeString(item.foods_json, 8000);
    } else if (item.foods_json !== undefined && item.foods_json !== null) {
      try {
        foodsJson = normalizeString(JSON.stringify(item.foods_json), 8000);
      } catch {
        foodsJson = null;
      }
    }

    const calories = normalizeNumber(item.calories, 0, 10000);
    const protein = normalizeNumber(item.protein, 0, 2000);
    const fat = normalizeNumber(item.fat, 0, 2000);
    const carbs = normalizeNumber(item.carbs, 0, 2000);
    const imageKey = item.image_key == null ? null : normalizeString(item.image_key, 512);

    // AI 写回采用“同日同餐替换”策略，避免同一餐生成多个冲突记录
    await db.prepare(
      'DELETE FROM diet_records WHERE user_id = ? AND meal_type = ? AND record_date = ?'
    )
      .bind(userId, mealType, recordDate)
      .run();

    const id = crypto.randomUUID();
    await db.prepare(
      'INSERT INTO diet_records (id, user_id, meal_type, record_date, food_description, foods_json, calories, protein, fat, carbs, image_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, userId, mealType, recordDate, foodDescription, foodsJson, calories, protein, fat, carbs, imageKey)
      .run();

    created += 1;
  }

  return created;
}

async function applyNutritionPlan(
  db: D1Database,
  userId: string,
  plan: ExtractedPlan | null | undefined,
  type: 'nutrition' | 'supplement'
): Promise<boolean> {
  if (!plan || typeof plan !== 'object') return false;
  const contentRaw = normalizeString(plan.content, 6000);
  if (!contentRaw || contentRaw.length < 12) return false;
  const planDate = asDateOnly(plan.plan_date);
  const content = type === 'supplement' && !contentRaw.startsWith('【补剂方案】')
    ? `【补剂方案】\n${contentRaw}`
    : contentRaw;

  const id = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO nutrition_plans (id, user_id, plan_date, content) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, planDate, content)
    .run();

  return true;
}

async function applyDailyLog(
  db: D1Database,
  userId: string,
  dailyLog: ExtractedDailyLog | null | undefined
): Promise<boolean> {
  if (!dailyLog || typeof dailyLog !== 'object') return false;

  const logDate =
    typeof dailyLog.log_date === 'string' && DATE_ONLY_REGEX.test(dailyLog.log_date)
      ? dailyLog.log_date
      : asDateOnly(undefined);

  const weight =
    typeof dailyLog.weight === 'number' &&
    Number.isFinite(dailyLog.weight) &&
    dailyLog.weight >= 20 &&
    dailyLog.weight <= 500
      ? dailyLog.weight
      : null;

  const sleepHours =
    typeof dailyLog.sleep_hours === 'number' &&
    Number.isFinite(dailyLog.sleep_hours) &&
    dailyLog.sleep_hours >= 0 &&
    dailyLog.sleep_hours <= 24
      ? dailyLog.sleep_hours
      : null;

  const sleepQuality =
    typeof dailyLog.sleep_quality === 'string' &&
    VALID_SLEEP_QUALITIES.includes(dailyLog.sleep_quality as SleepQuality)
      ? dailyLog.sleep_quality
      : null;

  const note = dailyLog.note == null ? null : normalizeString(dailyLog.note, 500);

  if (weight === null && sleepHours === null && sleepQuality === null && note === null) {
    return false;
  }

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO daily_logs (id, user_id, log_date, weight, sleep_hours, sleep_quality, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       weight = COALESCE(excluded.weight, daily_logs.weight),
       sleep_hours = COALESCE(excluded.sleep_hours, daily_logs.sleep_hours),
       sleep_quality = COALESCE(excluded.sleep_quality, daily_logs.sleep_quality),
       note = COALESCE(excluded.note, daily_logs.note)`
  )
    .bind(id, userId, logDate, weight, sleepHours, sleepQuality, note)
    .run();

  return true;
}

export async function applyAutoWriteback(
  db: D1Database,
  userId: string,
  extracted: ExtractedWritebackPayload | null,
  options?: { contextText?: string | null }
): Promise<OrchestrateAutoWriteSummary> {
  const summary: OrchestrateAutoWriteSummary = {
    profile_updated: false,
    conditions_upserted: 0,
    training_goals_upserted: 0,
    health_metrics_created: 0,
    training_plan_created: false,
    nutrition_plan_created: false,
    supplement_plan_created: false,
    diet_records_created: 0,
    daily_log_upserted: false,
  };

  if (!extracted) return summary;

  summary.profile_updated = await applyProfilePatch(db, userId, extracted.profile);
  summary.conditions_upserted = await applyConditions(db, userId, extracted.conditions);
  summary.training_goals_upserted = await applyTrainingGoals(
    db,
    userId,
    extracted.training_goals,
    extracted.training_goals_mode
  );
  summary.health_metrics_created = await applyHealthMetrics(db, userId, extracted.health_metrics);
  const contextText = typeof options?.contextText === 'string' ? options.contextText : '';

  summary.training_plan_created = await applyTrainingPlan(db, userId, extracted.training_plan, contextText);
  summary.nutrition_plan_created = await applyNutritionPlan(db, userId, extracted.nutrition_plan, 'nutrition');
  summary.supplement_plan_created = await applyNutritionPlan(db, userId, extracted.supplement_plan, 'supplement');
  summary.diet_records_created = await applyDietRecords(db, userId, extracted.diet_records, contextText);
  summary.daily_log_upserted = await applyDailyLog(db, userId, extracted.daily_log);

  return summary;
}

export async function saveOrchestrateHistory(
  db: D1Database,
  userId: string,
  userMessage: string,
  answer: string,
  imageUrl: string | null,
  metadata?: Record<string, unknown> | null
): Promise<void> {
  await saveOrchestrateUserMessage(db, userId, userMessage, imageUrl);
  await saveOrchestrateAssistantMessage(db, userId, answer, metadata);
}

export async function saveOrchestrateUserMessage(
  db: D1Database,
  userId: string,
  userMessage: string,
  imageUrl: string | null
): Promise<void> {
  const userIdRow = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO chat_history (id, user_id, role, message_role, content, image_url) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(userIdRow, userId, 'orchestrator', 'user', userMessage, imageUrl)
    .run();
}

export async function saveOrchestrateAssistantMessage(
  db: D1Database,
  userId: string,
  answer: string,
  metadata?: Record<string, unknown> | null
): Promise<void> {
  const assistantId = crypto.randomUUID();
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  await db.prepare(
    'INSERT INTO chat_history (id, user_id, role, message_role, content, metadata) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(assistantId, userId, 'orchestrator', 'assistant', answer, metadataJson)
    .run();
}

export type WritebackAuditSource = 'orchestrate' | 'orchestrate_stream';

export async function recordWritebackAudit(
  db: D1Database,
  userId: string,
  source: WritebackAuditSource,
  summary: OrchestrateAutoWriteSummary | null,
  error: string | null,
  messageExcerpt: string
): Promise<void> {
  const id = crypto.randomUUID();
  const status = error ? 'failed' : 'success';
  const summaryJson = summary ? JSON.stringify(summary) : null;
  const excerpt = messageExcerpt.length > 200 ? messageExcerpt.slice(0, 200) : messageExcerpt;
  await db.prepare(
    'INSERT INTO ai_writeback_audits (id, user_id, source, status, summary_json, error, message_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, source, status, summaryJson, error, excerpt)
    .run();
}

export async function runAutoOrchestrate(params: OrchestrateParams): Promise<OrchestrateResult> {
  const { env, userId, message, history, imageDataUri, imageUrl, autoWriteback } = params;
  const normalizedHistory = history
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map((item) => ({ role: item.role, content: item.content.trim() }))
    .filter((item) => item.content.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);

  const userContext = await getUserContext(env.DB, userId);
  const routing = await decideRoute(env, message, normalizedHistory);

  const primaryAnswer = await generatePrimaryAnswer(
    env,
    routing.primaryRole,
    userContext,
    normalizedHistory,
    message,
    imageDataUri
  );

  const supplements = await generateCollaboratorSupplements(
    env,
    routing.collaborators,
    userContext,
    message,
    routing.primaryRole,
    primaryAnswer
  );

  const finalAnswer = composeFinalAnswer(routing.primaryRole, primaryAnswer, supplements);
  await saveOrchestrateHistory(env.DB, userId, message, finalAnswer, imageUrl);

  let updateSummary: OrchestrateAutoWriteSummary = {
    profile_updated: false,
    conditions_upserted: 0,
    training_goals_upserted: 0,
    health_metrics_created: 0,
    training_plan_created: false,
    nutrition_plan_created: false,
    supplement_plan_created: false,
    diet_records_created: 0,
    daily_log_upserted: false,
  };

  if (autoWriteback) {
    try {
      const { payload, extractionError } = await resolveWritebackPayload(env, message, normalizedHistory, finalAnswer);
      updateSummary = await applyAutoWriteback(env.DB, userId, payload, {
        contextText: `${message}\n${finalAnswer}`,
      });

      const isWritebackFailed = Boolean(extractionError) && !hasWritebackChanges(updateSummary);
      if (isWritebackFailed) {
        throw new Error(extractionError || '自动写回失败');
      }

      try {
        await recordWritebackAudit(env.DB, userId, 'orchestrate', updateSummary, null, message);
      } catch {
        // ignore audit failure
      }
    } catch (error) {
      const logKey = `log:orchestrate-writeback-error:${Date.now()}:${crypto.randomUUID()}`;
      const payload = {
        userId,
        error: error instanceof Error ? error.message : '自动写回失败',
        at: new Date().toISOString(),
      };
      await env.KV.put(logKey, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 7 });
      try {
        await recordWritebackAudit(
          env.DB,
          userId,
          'orchestrate',
          null,
          error instanceof Error ? error.message : '自动写回失败',
          message
        );
      } catch {
        // ignore audit failure
      }
    }
  }

  return {
    answer: finalAnswer,
    primary_role: routing.primaryRole,
    collaborators: routing.collaborators,
    routing_reason: routing.reason,
    auto_writeback: autoWriteback,
    updates: updateSummary,
  };
}
