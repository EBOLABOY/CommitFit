import { parseContent } from './index';

export type MealName = '早餐' | '练前餐' | '午餐' | '练后餐' | '晚餐';
export type SupplementSectionName = '早餐' | '练前' | '午餐' | '练后' | '晚餐' | '睡前';

export interface StructuredNutritionPlan {
  baseInfo?: string;
  estimatedTdee?: string;
  calorieTarget?: string;
  macroTarget?: string;
  meals: Record<MealName, string[]>;
}

export interface StructuredSupplementPlan {
  basis: string[];
  notes: string[];
  sections: Record<SupplementSectionName, string[]>;
}

const SUPPLEMENT_PREFIX = '【补剂方案】';

export const SUPPLEMENT_KEYWORDS = [
  '补剂',
  '蛋白粉',
  '乳清',
  '肌酸',
  '鱼油',
  '维生素',
  '矿物质',
  '电解质',
  'bcaa',
  'omega',
  '辅酶',
  '镁',
  '锌',
];

export const MEAL_ORDER: MealName[] = ['早餐', '练前餐', '午餐', '练后餐', '晚餐'];
export const SUPPLEMENT_SECTION_ORDER: SupplementSectionName[] = ['早餐', '练前', '午餐', '练后', '晚餐', '睡前'];

export type DailyScheduleLike = {
  training_start_time?: string | null;
  breakfast_time?: string | null;
  lunch_time?: string | null;
  dinner_time?: string | null;
};

type TimedMealName = '早餐' | '午餐' | '晚餐';

const TIMED_MEAL_ORDER: TimedMealName[] = ['早餐', '午餐', '晚餐'];
const TIMED_MEAL_INDEX: Record<TimedMealName, number> = {
  早餐: 0,
  午餐: 1,
  晚餐: 2,
};
const FALLBACK_MEAL_MINUTES: Record<TimedMealName, number> = {
  早餐: 8 * 60,
  午餐: 12 * 60,
  晚餐: 19 * 60,
};

function isListItemLine(line: string): boolean {
  return /^[-*•]\s+/.test(line);
}

function isExplicitHeadingLine(line: string): boolean {
  if (isListItemLine(line)) return false;
  return /^#{1,6}\s*/.test(line) || /^\*\*.+\*\*$/.test(line) || /^\d+[.)、]\s*/.test(line);
}

function normalizeHeadingTextForSectionDetection(line: string): string {
  const raw = line
    .replace(/\u3000/g, ' ')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/^[\d]+[.)、]\s*/, '')
    .replace(/[：:]\s*$/, '')
    .trim();
  return raw.replace(/\s+/g, '');
}

function detectSupplementSectionByHeadingLine(line: string): SupplementSectionName | null {
  const compact = normalizeHeadingTextForSectionDetection(line);
  if (!compact) return null;
  if (compact.startsWith('早餐')) return '早餐';
  if (compact.startsWith('午餐')) return '午餐';
  if (compact.startsWith('晚餐')) return '晚餐';
  if (compact.startsWith('睡前')) return '睡前';
  if (compact.startsWith('练前餐') || compact.startsWith('训练前餐')) return null;
  if (compact.startsWith('练后餐') || compact.startsWith('训练后餐')) return null;
  if (compact.startsWith('练前') || compact.startsWith('训练前')) return '练前';
  if (compact.startsWith('练后') || compact.startsWith('训练后')) return '练后';
  return null;
}

function parseInlineHeadingLine<T extends string>(
  line: string,
  headings: readonly T[]
): { heading: T; content: string } | null {
  const normalized = line
    .replace(/\u3000/g, ' ')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/^[\d]+[.)、]\s*/, '')
    .trim();

  if (!normalized) return null;

  for (const heading of headings) {
    const m = normalized.match(new RegExp(`^${heading}\\s*[：:]\\s*(.+)$`));
    if (m) {
      const content = m[1].trim();
      if (content) return { heading, content };
    }
  }
  return null;
}

function hasLegacySupplementStructure(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  let workoutHeadingCount = 0;
  let hasKeyword = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!hasKeyword && SUPPLEMENT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
      hasKeyword = true;
    }
    if (!isExplicitHeadingLine(line)) continue;
    const section = detectSupplementSectionByHeadingLine(line);
    if (section === '练前' || section === '练后' || section === '睡前') {
      workoutHeadingCount += 1;
    }
  }

  return hasKeyword && workoutHeadingCount >= 2;
}

function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function buildTimedMeals(schedule?: DailyScheduleLike | null): Array<{ name: TimedMealName; min: number }> {
  const minutesMap: Record<TimedMealName, number> = {
    早餐: timeToMinutes(schedule?.breakfast_time) ?? FALLBACK_MEAL_MINUTES.早餐,
    午餐: timeToMinutes(schedule?.lunch_time) ?? FALLBACK_MEAL_MINUTES.午餐,
    晚餐: timeToMinutes(schedule?.dinner_time) ?? FALLBACK_MEAL_MINUTES.晚餐,
  };

  return TIMED_MEAL_ORDER
    .map((name) => ({ name, min: minutesMap[name] }))
    .sort((a, b) => a.min - b.min || TIMED_MEAL_INDEX[a.name] - TIMED_MEAL_INDEX[b.name]);
}

export function getMealOrder(schedule?: DailyScheduleLike | null): MealName[] {
  const tMin = timeToMinutes(schedule?.training_start_time);
  if (tMin == null) return MEAL_ORDER;

  const meals = buildTimedMeals(schedule);

  const insertIdx = (() => {
    const idx = meals.findIndex((m) => tMin <= m.min);
    return idx >= 0 ? idx : meals.length;
  })();

  const beforeMeals = meals.slice(0, insertIdx).map((m) => m.name);
  const afterMeals = meals.slice(insertIdx).map((m) => m.name);
  return [...beforeMeals, '练前餐', '练后餐', ...afterMeals];
}

export function getSupplementSectionOrder(schedule?: DailyScheduleLike | null): SupplementSectionName[] {
  const tMin = timeToMinutes(schedule?.training_start_time);
  if (tMin == null) return SUPPLEMENT_SECTION_ORDER;

  const meals = buildTimedMeals(schedule);

  const insertIdx = (() => {
    const idx = meals.findIndex((m) => tMin <= m.min);
    return idx >= 0 ? idx : meals.length;
  })();

  const beforeMeals = meals.slice(0, insertIdx).map((m) => m.name);
  const afterMeals = meals.slice(insertIdx).map((m) => m.name);
  return [...beforeMeals, '练前', '练后', ...afterMeals, '睡前'];
}

export function isSupplementPlan(content: string): boolean {
  const normalized = parseContent(content).replace(/\r/g, '').trim();
  if (!normalized) return false;
  if (normalized.startsWith(SUPPLEMENT_PREFIX)) return true;
  if (/(^|\n)\s*(#{1,6}\s*)?补剂方案/.test(normalized)) return true;
  if (/(^|\n)\s*(#{1,6}\s*)?分时段补剂方案/.test(normalized)) return true;
  return hasLegacySupplementStructure(normalized);
}

export function parseStructuredNutritionPlan(content: string): StructuredNutritionPlan | null {
  const text = parseContent(content).replace(/\r/g, '');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const meals: Record<MealName, string[]> = {
    早餐: [],
    练前餐: [],
    午餐: [],
    练后餐: [],
    晚餐: [],
  };

  let currentMeal: MealName | null = null;
  let baseInfo: string | undefined;
  let estimatedTdee: string | undefined;
  let calorieTarget: string | undefined;
  let macroTarget: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u3000/g, ' ').trim();
    if (!line) continue;

    const heading = line.replace(/^#{1,6}\s*/, '').replace(/[：:]\s*$/, '').trim();
    const compactHeading = heading.replace(/\s+/g, '');
    const plainMealHeading = line.match(/^(早餐|练前餐|训练前餐|午餐|练后餐|训练后餐|晚餐)\s*[：:]?\s*$/)?.[1];
    const inlineMealHeading = parseInlineHeadingLine(
      line,
      ['早餐', '练前餐', '训练前餐', '午餐', '练后餐', '训练后餐', '晚餐'] as const
    );
    const canDetectHeading = isExplicitHeadingLine(line) || !!plainMealHeading || !!inlineMealHeading;

    // Order matters: check 练前餐/练后餐 before 午餐/晚餐 to avoid partial match
    if (canDetectHeading && (compactHeading.includes('练前餐') || compactHeading.includes('训练前餐') || plainMealHeading === '练前餐' || plainMealHeading === '训练前餐')) {
      currentMeal = '练前餐';
      if (inlineMealHeading && (inlineMealHeading.heading === '练前餐' || inlineMealHeading.heading === '训练前餐')) {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }
    if (canDetectHeading && (compactHeading.includes('练后餐') || compactHeading.includes('训练后餐') || plainMealHeading === '练后餐' || plainMealHeading === '训练后餐')) {
      currentMeal = '练后餐';
      if (inlineMealHeading && (inlineMealHeading.heading === '练后餐' || inlineMealHeading.heading === '训练后餐')) {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }
    if (canDetectHeading && (compactHeading.includes('早餐') || plainMealHeading === '早餐')) {
      currentMeal = '早餐';
      if (inlineMealHeading && inlineMealHeading.heading === '早餐') {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }
    if (canDetectHeading && (compactHeading.includes('午餐') || plainMealHeading === '午餐')) {
      currentMeal = '午餐';
      if (inlineMealHeading && inlineMealHeading.heading === '午餐') {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }
    if (canDetectHeading && (compactHeading.includes('晚餐') || plainMealHeading === '晚餐')) {
      currentMeal = '晚餐';
      if (inlineMealHeading && inlineMealHeading.heading === '晚餐') {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }

    if (/^#{1,6}\s*/.test(line)) {
      currentMeal = null;
    }

    const normalized = line
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .trim();
    if (!normalized) continue;

    if (!baseInfo && /(基础信息|身高|体重|年龄|性别|训练目标)/.test(normalized) && /(身高|体重|目标)/.test(normalized)) {
      baseInfo = normalized;
    } else if (!estimatedTdee && /(估算消耗|每日总消耗|TDEE)/i.test(normalized)) {
      estimatedTdee = normalized;
    } else if (!calorieTarget && /热量目标/.test(normalized)) {
      calorieTarget = normalized;
    } else if (!macroTarget && /(三大营养素目标|蛋白质.*碳水.*脂肪|蛋白.*碳水.*脂肪)/.test(normalized)) {
      macroTarget = normalized;
    }

    if (currentMeal) {
      meals[currentMeal].push(normalized);
    }
  }

  const hasMealContent = MEAL_ORDER.some((meal) => meals[meal].length > 0);
  if (!hasMealContent) return null;

  return {
    baseInfo,
    estimatedTdee,
    calorieTarget,
    macroTarget,
    meals,
  };
}

export function parseStructuredSupplementPlan(content: string): StructuredSupplementPlan | null {
  const text = parseContent(content).replace(/\r/g, '');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const sections: Record<SupplementSectionName, string[]> = {
    早餐: [],
    午餐: [],
    练前: [],
    练后: [],
    晚餐: [],
    睡前: [],
  };
  const basis: string[] = [];
  const notes: string[] = [];

  let currentSection: SupplementSectionName | null = null;
  let mode: 'basis' | 'notes' | 'section' | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u3000/g, ' ').trim();
    if (!line) continue;

    const heading = line.replace(/^#{1,6}\s*/, '').replace(/[：:]\s*$/, '').trim();
    const compactHeading = heading.replace(/\s+/g, '');
    const plainSectionHeading = line.match(/^(早餐|午餐|练前|训练前|练后|训练后|晚餐|睡前)\s*[：:]?\s*$/)?.[1];
    const plainMetaHeading = line.match(/^(补剂方案依据|总剂量与注意事项|注意事项)\s*[：:]?\s*$/)?.[1];
    const inlineSectionHeading = parseInlineHeadingLine(
      line,
      ['早餐', '午餐', '练前', '训练前', '练后', '训练后', '晚餐', '睡前'] as const
    );
    const inlineMetaHeading = parseInlineHeadingLine(
      line,
      ['补剂方案依据', '总剂量与注意事项', '注意事项'] as const
    );
    const canDetectHeading =
      isExplicitHeadingLine(line) || !!plainSectionHeading || !!plainMetaHeading || !!inlineSectionHeading || !!inlineMetaHeading;

    if (
      canDetectHeading
      && (
        compactHeading.includes('补剂方案依据')
        || plainMetaHeading === '补剂方案依据'
        || inlineMetaHeading?.heading === '补剂方案依据'
      )
    ) {
      mode = 'basis';
      currentSection = null;
      if (inlineMetaHeading && inlineMetaHeading.heading === '补剂方案依据') {
        basis.push(inlineMetaHeading.content);
      }
      continue;
    }

    if (
      canDetectHeading
      && (
        compactHeading.includes('总剂量与注意事项')
        || compactHeading.includes('注意事项')
        || plainMetaHeading === '总剂量与注意事项'
        || plainMetaHeading === '注意事项'
        || inlineMetaHeading?.heading === '总剂量与注意事项'
        || inlineMetaHeading?.heading === '注意事项'
      )
    ) {
      mode = 'notes';
      currentSection = null;
      if (inlineMetaHeading && (inlineMetaHeading.heading === '总剂量与注意事项' || inlineMetaHeading.heading === '注意事项')) {
        notes.push(inlineMetaHeading.content);
      }
      continue;
    }

    const sectionMap: Record<string, SupplementSectionName> = {
      早餐: '早餐',
      午餐: '午餐',
      练前: '练前',
      训练前: '练前',
      练后: '练后',
      训练后: '练后',
      晚餐: '晚餐',
      睡前: '睡前',
    };
    const detectedByHeading = canDetectHeading ? detectSupplementSectionByHeadingLine(line) : null;
    if (detectedByHeading || plainSectionHeading || inlineSectionHeading) {
      const headingKey = inlineSectionHeading?.heading ?? plainSectionHeading;
      currentSection = headingKey ? sectionMap[headingKey] : detectedByHeading;
      mode = 'section';
      if (inlineSectionHeading && currentSection) {
        sections[currentSection].push(inlineSectionHeading.content);
      }
      continue;
    }

    if (/^#{1,6}\s*/.test(line)) {
      currentSection = null;
      mode = null;
      continue;
    }

    const normalized = line
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .trim();
    if (!normalized) continue;

    if (mode === 'basis') {
      basis.push(normalized);
      continue;
    }

    if (mode === 'notes') {
      notes.push(normalized);
      continue;
    }

    if (mode === 'section' && currentSection) {
      sections[currentSection].push(normalized);
    }
  }

  const hasSectionContent = SUPPLEMENT_SECTION_ORDER.some((section) => sections[section].length > 0);
  if (!hasSectionContent) return null;

  return { basis, notes, sections };
}
