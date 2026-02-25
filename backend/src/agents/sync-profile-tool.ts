import { z } from 'zod';

export const syncProfileToolSchema = z.object({
  profile: z.object({
    height: z.number().optional(),
    weight: z.number().optional(),
    age: z.number().optional(),
    gender: z.enum(['male', 'female']).optional(),
    experience_level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  }).optional(),
  conditions: z.array(z.object({
    name: z.string(),
    severity: z.enum(['mild', 'moderate', 'severe']).optional(),
    status: z.enum(['active', 'recovered']).optional().default('active'),
  })).max(5).optional(),
  training_goals: z.array(z.object({
    name: z.string(),
    status: z.enum(['active', 'completed']).optional().default('active'),
  })).max(5).optional(),
  health_metrics: z.array(z.object({
    metric_type: z.enum(['testosterone', 'blood_pressure', 'blood_lipids', 'blood_sugar', 'heart_rate', 'body_fat', 'other']).optional(),
    value: z.string(),
    unit: z.string().optional(),
  })).max(6).optional(),
  daily_log: z.object({
    weight: z.number().optional(),
    sleep_hours: z.number().optional(),
  }).optional(),
  summary_text: z.string().describe('对用户友好的中文摘要，说明要同步哪些数据'),
});
