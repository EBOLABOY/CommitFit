import { z } from 'zod';

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeHHmmSchema = z.string()
  .regex(/^(\d{1,2}):(\d{2})$/)
  .refine((v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m) return false;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    return Number.isInteger(hh) && Number.isInteger(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
  }, { message: '必须是 HH:mm（24小时制，例如 06:00 或 15:00）' });
const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);

const summaryTextSchema = z
  .string()
  .max(200)
  .optional()
  .describe('可选：对用户友好的中文摘要，说明要执行哪些写回操作（用于操作提示/反馈；若启用 tool approval，则用于审批提示）');

// --- User/Profile patches ---

export const userPatchToolSchema = z.object({
  nickname: z.string().max(50).nullable().optional(),
  avatar_key: z.string().max(512).nullable().optional(),
  summary_text: summaryTextSchema,
}).refine((v) => v.nickname != null || v.avatar_key != null, {
  message: '必须至少提供 nickname 或 avatar_key',
});

export const profilePatchToolSchema = z.object({
  height: z.number().min(50).max(300).optional(),
  weight: z.number().min(20).max(500).optional(),
  birth_date: dateOnlySchema.optional(),
  gender: z.enum(['male', 'female']).optional(),
  training_start_time: timeHHmmSchema.optional().describe('每日训练开始时间（24小时制 HH:mm，例如 06:00 或 15:00）'),
  breakfast_time: timeHHmmSchema.optional().describe('早餐时间（24小时制 HH:mm，例如 08:00）'),
  lunch_time: timeHHmmSchema.optional().describe('午餐时间（24小时制 HH:mm，例如 12:00）'),
  dinner_time: timeHHmmSchema.optional().describe('晚餐时间（24小时制 HH:mm，例如 18:00）'),
  training_years: z.number().min(0).max(80).optional(),
  training_goal: z.string().max(200).optional(),
  summary_text: summaryTextSchema,
}).refine((v) => Object.keys(v).some((k) => k !== 'summary_text'), {
  message: '必须至少提供一个可更新字段',
});

// --- Conditions (伤病) ---

const conditionItemSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  severity: z.enum(['mild', 'moderate', 'severe']).optional(),
  status: z.enum(['active', 'recovered']).optional(),
});

export const conditionsUpsertToolSchema = z.object({
  conditions: z.array(conditionItemSchema).min(1).max(5),
  summary_text: summaryTextSchema,
});

export const conditionsReplaceAllToolSchema = z.object({
  conditions: z.array(conditionItemSchema).min(1).max(5),
  summary_text: summaryTextSchema,
});

export const conditionsDeleteToolSchema = z.object({
  ids: z.array(z.string().max(64)).min(1).max(10).describe('要删除的伤病记录 id 列表'),
  summary_text: summaryTextSchema,
});

export const conditionsClearAllToolSchema = z.object({
  summary_text: summaryTextSchema,
});

// --- Training goals (训练目标) ---

const trainingGoalItemSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(4000).optional(),
  status: z.enum(['active', 'completed']).optional(),
});

export const trainingGoalsUpsertToolSchema = z.object({
  goals: z.array(trainingGoalItemSchema).min(1).max(5),
  summary_text: summaryTextSchema,
});

export const trainingGoalsReplaceAllToolSchema = z.object({
  goals: z.array(trainingGoalItemSchema).min(1).max(5),
  summary_text: summaryTextSchema,
});

export const trainingGoalsDeleteToolSchema = z.object({
  ids: z.array(z.string().max(64)).min(1).max(10).describe('要删除的训练目标 id 列表'),
  summary_text: summaryTextSchema,
});

export const trainingGoalsClearAllToolSchema = z.object({
  summary_text: summaryTextSchema,
});

// --- Health metrics (理化指标) ---

const healthMetricCreateItemSchema = z.object({
  metric_type: z
    .enum(['testosterone', 'blood_pressure', 'blood_lipids', 'blood_sugar', 'heart_rate', 'body_fat', 'other'])
    .optional(),
  value: z.string().min(1).max(500),
  unit: z.string().max(20).optional(),
  recorded_at: dateOnlySchema.optional(),
});

export const healthMetricsCreateToolSchema = z.object({
  metrics: z.array(healthMetricCreateItemSchema).min(1).max(6),
  summary_text: summaryTextSchema,
});

const healthMetricUpdateItemSchema = z.object({
  id: z.string().min(1).max(64),
  value: z.string().max(500).optional(),
  unit: z.string().max(20).optional(),
  recorded_at: dateOnlySchema.optional(),
}).refine((v) => v.value != null || v.unit != null || v.recorded_at != null, {
  message: 'health_metrics_update 每项必须至少包含 value/unit/recorded_at 之一',
});

export const healthMetricsUpdateToolSchema = z.object({
  updates: z.array(healthMetricUpdateItemSchema).min(1).max(10),
  summary_text: summaryTextSchema,
});

export const healthMetricsDeleteToolSchema = z.object({
  ids: z.array(z.string().max(64)).min(1).max(10),
  summary_text: summaryTextSchema,
});

// --- Training plan (训练计划) ---

export const trainingPlanSetToolSchema = z.object({
  plan_date: dateOnlySchema.optional().describe('可选：YYYY-MM-DD；不填则可由上下文推断（今天/明天/本周）'),
  content: z.string().min(12).max(12000),
  notes: z.string().max(500).optional(),
  completed: z.boolean().optional(),
  summary_text: summaryTextSchema,
});

export const trainingPlanDeleteToolSchema = z.object({
  plan_date: dateOnlySchema.optional().describe('可选：YYYY-MM-DD；不填则由上下文推断'),
  summary_text: summaryTextSchema,
});

// --- Nutrition/Supplement plans (营养/补剂方案) ---

export const nutritionPlanSetToolSchema = z.object({
  plan_date: dateOnlySchema.optional(),
  content: z.string().min(12).max(12000),
  summary_text: summaryTextSchema,
});

export const nutritionPlanDeleteToolSchema = z.object({
  plan_date: dateOnlySchema.optional(),
  summary_text: summaryTextSchema,
});

export const supplementPlanSetToolSchema = z.object({
  plan_date: dateOnlySchema.optional(),
  content: z.string().min(12).max(12000),
  summary_text: summaryTextSchema,
});

export const supplementPlanDeleteToolSchema = z.object({
  plan_date: dateOnlySchema.optional(),
  summary_text: summaryTextSchema,
});

// --- Diet records (饮食记录) ---

const dietRecordCreateItemSchema = z.object({
  meal_type: mealTypeSchema,
  record_date: dateOnlySchema.optional(),
  food_description: z.string().min(1).max(1000),
  foods_json: z.string().max(2400).optional(),
  calories: z.number().optional(),
  protein: z.number().optional(),
  fat: z.number().optional(),
  carbs: z.number().optional(),
  image_key: z.string().max(512).optional(),
});

export const dietRecordsCreateToolSchema = z.object({
  records: z.array(dietRecordCreateItemSchema).min(1).max(8),
  summary_text: summaryTextSchema,
});

const dietRecordDeleteItemSchema = z.object({
  id: z.string().max(64).optional(),
  meal_type: mealTypeSchema.optional(),
  record_date: dateOnlySchema.optional(),
}).refine((v) => Boolean(v.id) || Boolean(v.meal_type), {
  message: 'diet_records_delete 每项必须提供 id，或至少提供 meal_type（日期可由上下文推断）',
});

export const dietRecordsDeleteToolSchema = z.object({
  deletes: z.array(dietRecordDeleteItemSchema).min(1).max(8),
  summary_text: summaryTextSchema,
});

// --- Daily logs (每日日志) ---

export const dailyLogUpsertToolSchema = z.object({
  log_date: dateOnlySchema.optional(),
  weight: z.number().optional(),
  sleep_hours: z.number().optional(),
  sleep_quality: z.enum(['good', 'fair', 'poor']).optional(),
  note: z.string().max(1200).optional(),
  summary_text: summaryTextSchema,
}).refine(
  (v) => v.weight != null || v.sleep_hours != null || v.sleep_quality != null || v.note != null,
  { message: 'daily_log 至少提供一个字段（weight/sleep/note）' }
);

export const dailyLogDeleteToolSchema = z.object({
  log_date: dateOnlySchema.optional(),
  summary_text: summaryTextSchema,
});
