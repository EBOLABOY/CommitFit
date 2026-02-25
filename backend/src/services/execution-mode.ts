import type { Bindings } from '../types';

export type ExecutionMode = 'main' | 'role';

export interface ExecutionDecision {
  mode: ExecutionMode;
  reason: string;
  source: 'llm' | 'fallback';
}

// 为了不“限制主模型能力”，这里采用更保守的规则：
// 仅在用户明确要生成/制定/安排训练计划、饮食/营养方案、补剂方案时才切换 role 模型；
// 其余（包括解释、常规问答、增删改查）默认走 main。
const TIME_RANGE_HINT = /(今天|今日|明天|明日|后天|本周|下周|一周|7天|七天|周末)/;
const GENERATION_VERBS = /(生成|制定|安排|写|出一份|做一份|规划|优化|调整|改写|重写|替换)/i;

const TRAINING_PLAN_HINT = /(训练计划|周计划|训练安排|训练方案|训练表|一周训练)/i;
const TRAINING_TIME_BASED = /(训练).{0,6}(计划|安排|方案|内容)/;

const NUTRITION_PLAN_HINT = /(营养方案|饮食方案|饮食计划|饮食安排|营养计划|食谱|餐单)/i;
const NUTRITION_TIME_BASED = /(饮食|营养).{0,6}(计划|安排|方案|食谱)/;

const SUPPLEMENT_PLAN_HINT = /(补剂方案|补剂计划|补剂清单)/i;
const SUPPLEMENT_TIME_BASED = /(补剂).{0,6}(计划|安排|方案|清单)/;

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > 80 ? text.slice(0, 80) : text;
}

function fallbackDecision(message: string, hasImageInput: boolean): ExecutionDecision {
  if (hasImageInput) {
    return {
      mode: 'role',
      reason: '图片输入默认走深度生成模型',
      source: 'fallback',
    };
  }

  const text = message.trim();
  const isPlanLike =
    TRAINING_PLAN_HINT.test(text) ||
    NUTRITION_PLAN_HINT.test(text) ||
    SUPPLEMENT_PLAN_HINT.test(text) ||
    (TIME_RANGE_HINT.test(text) && (TRAINING_TIME_BASED.test(text) || NUTRITION_TIME_BASED.test(text) || SUPPLEMENT_TIME_BASED.test(text)));

  const isGenerationRequest = GENERATION_VERBS.test(text) || TIME_RANGE_HINT.test(text);
  const isComplex = isPlanLike && isGenerationRequest;

  return {
    mode: isComplex ? 'role' : 'main',
    reason: isComplex ? '涉及计划/方案生成，切换 role 模型' : '默认主模型（解释/问答/CRUD）',
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

  // 不再调用 LLM 做分流，避免额外开销与误判导致“主模型被限制”。
  // 保留 env 参数是为了兼容既有调用签名与未来扩展。
  void env;
  const decision = fallbackDecision(message, hasImageInput);
  return {
    ...decision,
    reason: normalizeReason(decision.reason) || decision.reason,
  };
}
