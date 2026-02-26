import { z } from 'zod';

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// NOTE:
// AI SDK tool schemas must compile to a JSON Schema with top-level { type: "object" }.
// z.discriminatedUnion(...) may compile to an unsupported schema ("type: None") at runtime.
// Keep a single object schema and validate semantic constraints in the tool execute() switch.

const resourceSchema = z.enum([
  'user',
  'profile',
  'conditions',
  'training_goals',
  'health_metrics',
  'training_plans',
  'nutrition_plans',
  'diet_records',
  'daily_logs',
]);

const metricTypeSchema = z.enum([
  'testosterone',
  'blood_pressure',
  'blood_lipids',
  'blood_sugar',
  'heart_rate',
  'body_fat',
  'other',
]);

const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);

export const queryUserDataToolSchema = z.object({
  resource: resourceSchema.describe('要查询的数据资源类型'),

  // Common filters (some only apply to certain resources; tool execute() will interpret them)
  status: z.enum(['active', 'recovered', 'completed', 'all']).optional().describe('可选：状态过滤（按资源语义）'),
  metric_type: metricTypeSchema.optional().describe('可选：理化指标类型过滤（health_metrics）'),
  plan_kind: z.enum(['nutrition', 'supplement', 'all']).optional().describe('可选：营养计划类型过滤（nutrition_plans）'),
  meal_type: mealTypeSchema.optional().describe('可选：餐次过滤（diet_records）'),
  date_from: dateOnlySchema.optional().describe('可选：起始日期（YYYY-MM-DD）'),
  date_to: dateOnlySchema.optional().describe('可选：结束日期（YYYY-MM-DD）'),
  limit: z.number().int().min(1).max(50).optional().describe('可选：返回条数上限'),
});
