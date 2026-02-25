import { z } from 'zod';

const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const conditionsModeSchema = z.enum(['upsert', 'replace_all', 'clear_all']);
const trainingGoalsModeSchema = z.enum(['upsert', 'replace_all', 'clear_all']);

export const syncProfileToolSchema = z.object({
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
  training_goals: z.array(z.object({
    name: z.string().max(100),
    description: z.string().max(4000).optional(),
    status: z.enum(['active', 'completed']).optional().default('active'),
  })).max(5).optional(),
  training_goals_mode: trainingGoalsModeSchema.optional().describe('训练目标写入模式：upsert=合并更新；replace_all=先清空再写入传入列表；clear_all=仅清空'),
  health_metrics: z.array(z.object({
    metric_type: z.enum(['testosterone', 'blood_pressure', 'blood_lipids', 'blood_sugar', 'heart_rate', 'body_fat', 'other']).optional(),
    value: z.string(),
    unit: z.string().optional(),
    recorded_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).max(6).optional(),
  training_plan: z.object({
    plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    content: z.string(),
    notes: z.string().optional(),
    completed: z.boolean().optional(),
  }).optional(),
  nutrition_plan: z.object({
    plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    content: z.string(),
  }).optional(),
  supplement_plan: z.object({
    plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    content: z.string(),
  }).optional(),
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
  daily_log: z.object({
    log_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    weight: z.number().optional(),
    sleep_hours: z.number().optional(),
    sleep_quality: z.enum(['good', 'fair', 'poor']).optional(),
    note: z.string().optional(),
  }).optional(),
  summary_text: z.string().describe('对用户友好的中文摘要，说明要同步哪些数据'),
});
