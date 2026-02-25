import { z } from 'zod';

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

export const queryUserDataToolSchema = z.discriminatedUnion('resource', [
  z.object({
    resource: z.literal('user'),
  }),
  z.object({
    resource: z.literal('profile'),
  }),
  z.object({
    resource: z.literal('conditions'),
    status: z.enum(['active', 'recovered', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    resource: z.literal('training_goals'),
    status: z.enum(['active', 'completed', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    resource: z.literal('health_metrics'),
    metric_type: metricTypeSchema.optional(),
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    resource: z.literal('training_plans'),
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  z.object({
    resource: z.literal('nutrition_plans'),
    plan_kind: z.enum(['nutrition', 'supplement', 'all']).optional(),
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  z.object({
    resource: z.literal('diet_records'),
    meal_type: mealTypeSchema.optional(),
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    resource: z.literal('daily_logs'),
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
]);

