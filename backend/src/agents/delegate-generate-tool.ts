import { z } from 'zod';

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const delegateGenerateToolSchema = z.object({
  kind: z
    .enum(['training_plan', 'nutrition_plan', 'supplement_plan', 'analysis'])
    .describe('委托生成类型：训练计划/饮食方案/补剂方案/分析'),
  role: z
    .enum(['doctor', 'rehab', 'nutritionist', 'trainer'])
    .optional()
    .describe('可选：希望以哪个角色视角生成（未传则由主链路决定）'),
  plan_date: dateOnlySchema
    .optional()
    .describe('可选：计划日期（YYYY-MM-DD）。不确定可不传，让主链路推断/由正文表达相对日期。'),
  image_url: z
    .string()
    .url()
    .max(2048)
    .optional()
    .describe('可选：图片 URL（用于图片识别/分析类任务）。'),
  request: z
    .string()
    .min(1)
    .max(6000)
    .describe('生成/分析请求（中文）。建议包含必要背景与约束，但不要包含账号/密码等敏感信息。'),
});
