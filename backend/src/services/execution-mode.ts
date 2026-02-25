import type { Bindings } from '../types';
import { callLLMNonStream } from './llm';

export type ExecutionMode = 'main' | 'role';

export interface ExecutionDecision {
  mode: ExecutionMode;
  reason: string;
  source: 'llm' | 'fallback';
}

const COMPLEX_FALLBACK_PATTERNS = [
  /训练计划|周计划|今日训练|明日训练|动作安排/i,
  /营养方案|饮食方案|补剂方案|食谱|宏量营养/i,
  /分析|识别|评估|解读|诊断|总结/i,
  /生成|制定|安排|优化|重构|改写/i,
  /图片|拍照|上传|图像/i,
];

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > 80 ? text.slice(0, 80) : text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
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
      // continue trying
    }
  }
  return null;
}

function fallbackDecision(message: string, hasImageInput: boolean): ExecutionDecision {
  if (hasImageInput) {
    return {
      mode: 'role',
      reason: '图片输入默认走深度生成模型',
      source: 'fallback',
    };
  }
  const isComplex = COMPLEX_FALLBACK_PATTERNS.some((pattern) => pattern.test(message));
  return {
    mode: isComplex ? 'role' : 'main',
    reason: isComplex ? '命中复杂任务规则' : '命中简单任务规则',
    source: 'fallback',
  };
}

export async function decideExecutionMode(
  env: Bindings,
  message: string,
  hasImageInput: boolean
): Promise<ExecutionDecision> {
  if (!message.trim()) {
    return {
      mode: 'main',
      reason: '空消息默认主模型',
      source: 'fallback',
    };
  }

  const prompt = [
    '你是任务复杂度分流器。请判断用户请求该走哪条模型执行链路：',
    '- main: 简单问答、轻量信息确认、短解释、常规增删改查指导。',
    '- role: 需要深度生成或分析，例如训练计划、营养/补剂方案、图片分析、复杂评估。',
    '',
    '你必须只输出 JSON，不要输出任何额外文字：',
    '{"mode":"main","reason":"一句话理由"}',
    '',
    `用户请求：${message}`,
    `是否包含图片输入：${hasImageInput ? '是' : '否'}`,
  ].join('\n');

  try {
    const raw = await callLLMNonStream({
      env,
      messages: [
        { role: 'system', content: '你是严格 JSON 分流器，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      timeoutMs: 20_000,
      maxAttempts: 1,
    });

    const obj = parseJsonObject(raw);
    if (!obj) return fallbackDecision(message, hasImageInput);

    const mode = obj.mode;
    const reason = normalizeReason(obj.reason);
    if (mode === 'main' || mode === 'role') {
      return {
        mode,
        reason: reason || (mode === 'role' ? 'LLM 判定为复杂任务' : 'LLM 判定为简单任务'),
        source: 'llm',
      };
    }
    return fallbackDecision(message, hasImageInput);
  } catch {
    return fallbackDecision(message, hasImageInput);
  }
}
