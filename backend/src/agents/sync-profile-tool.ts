import { z } from 'zod';

const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const conditionsModeSchema = z.enum(['upsert', 'replace_all', 'clear_all']);
const trainingGoalsModeSchema = z.enum(['upsert', 'replace_all', 'clear_all']);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const syncProfileToolSchema = z.object({
  user: z.object({
    nickname: z.string().max(50).nullable().optional(),
    avatar_key: z.string().max(512).nullable().optional(),
  }).optional(),
  profile: z.object({
    height: z.number().optional(),
    weight: z.number().optional(),
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    gender: z.enum(['male', 'female']).optional(),
    training_goal: z.string().optional(),
    training_years: z.number().optional(),
  }).optional(),
  conditions: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    severity: z.enum(['mild', 'moderate', 'severe']).optional(),
    status: z.enum(['active', 'recovered']).optional().default('active'),
  })).max(5).optional(),
  conditions_mode: conditionsModeSchema.optional().describe('伤病记录写入模式：upsert=合并更新；replace_all=先清空再写入传入列表；clear_all=仅清空'),
  conditions_delete_ids: z.array(z.string().max(64)).max(10).optional().describe('按 id 删除指定伤病记录（优先使用）'),
  training_goals: z.array(z.object({
    name: z.string().max(100),
    description: z.string().max(4000).optional(),
    status: z.enum(['active', 'completed']).optional().default('active'),
  })).max(5).optional(),
  training_goals_mode: trainingGoalsModeSchema.optional().describe('训练目标写入模式：upsert=合并更新；replace_all=先清空再写入传入列表；clear_all=仅清空'),
  training_goals_delete_ids: z.array(z.string().max(64)).max(10).optional().describe('按 id 删除指定训练目标（优先使用）'),
  health_metrics: z.array(z.object({
    metric_type: z.enum(['testosterone', 'blood_pressure', 'blood_lipids', 'blood_sugar', 'heart_rate', 'body_fat', 'other']).optional(),
    value: z.string(),
    unit: z.string().optional(),
    recorded_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).max(6).optional(),
  health_metrics_update: z.array(z.object({
    id: z.string().max(64),
    value: z.string().max(500).optional(),
    unit: z.string().max(20).optional(),
    recorded_at: dateOnlySchema.optional(),
  })).max(10).optional().describe('按 id 更新理化指标（改）'),
  health_metrics_delete_ids: z.array(z.string().max(64)).max(10).optional().describe('按 id 删除理化指标（删）'),
  training_plan: z.object({
    plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    content: z.string(),
    notes: z.string().optional(),
    completed: z.boolean().optional(),
  }).optional(),
  training_plan_delete_date: dateOnlySchema.optional().describe('删除指定日期的训练计划（同日只保留一份计划）'),
  nutrition_plan: z.object({
    plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    content: z.string(),
  }).optional(),
  nutrition_plan_delete_date: dateOnlySchema.optional().describe('删除指定日期的饮食方案（不含补剂方案）'),
  supplement_plan: z.object({
    plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    content: z.string(),
  }).optional(),
  supplement_plan_delete_date: dateOnlySchema.optional().describe('删除指定日期的补剂方案'),
  diet_records: z.array(z.object({
    meal_type: mealTypeSchema,
    record_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    food_description: z.string(),
    foods_json: z.string().optional(),
    calories: z.number().optional(),
    protein: z.number().optional(),
    fat: z.number().optional(),
    carbs: z.number().optional(),
    image_key: z.string().optional(),
  })).max(8).optional(),
  diet_records_delete: z.array(z.object({
    id: z.string().max(64).optional(),
    meal_type: mealTypeSchema.optional(),
    record_date: dateOnlySchema.optional(),
  })).max(8).optional().describe('删除饮食记录：优先使用 id；否则使用 meal_type + record_date'),
  daily_log: z.object({
    log_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    weight: z.number().optional(),
    sleep_hours: z.number().optional(),
    sleep_quality: z.enum(['good', 'fair', 'poor']).optional(),
    note: z.string().optional(),
  }).optional(),
  daily_log_delete_date: dateOnlySchema.optional().describe('删除指定日期的体重/睡眠日志'),
  summary_text: z.string().describe('对用户友好的中文摘要，说明要同步哪些数据'),
});
