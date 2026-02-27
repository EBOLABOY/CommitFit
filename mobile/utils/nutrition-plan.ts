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

function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

export function getMealOrder(schedule?: DailyScheduleLike | null): MealName[] {
  const tMin = timeToMinutes(schedule?.training_start_time);
  const bMin = timeToMinutes(schedule?.breakfast_time);
  const lMin = timeToMinutes(schedule?.lunch_time);
  const dMin = timeToMinutes(schedule?.dinner_time);

  // 训练时间/三餐时间缺失时，回退为默认展示顺序
  if (tMin == null || bMin == null || lMin == null || dMin == null) return MEAL_ORDER;

  const meals = [
    { name: '早餐' as const, min: bMin },
    { name: '午餐' as const, min: lMin },
    { name: '晚餐' as const, min: dMin },
  ].sort((a, b) => a.min - b.min);

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
  const bMin = timeToMinutes(schedule?.breakfast_time);
  const lMin = timeToMinutes(schedule?.lunch_time);
  const dMin = timeToMinutes(schedule?.dinner_time);

  if (tMin == null || bMin == null || lMin == null || dMin == null) return SUPPLEMENT_SECTION_ORDER;

  const meals = [
    { name: '早餐' as const, min: bMin },
    { name: '午餐' as const, min: lMin },
    { name: '晚餐' as const, min: dMin },
  ].sort((a, b) => a.min - b.min);

  const insertIdx = (() => {
    const idx = meals.findIndex((m) => tMin <= m.min);
    return idx >= 0 ? idx : meals.length;
  })();

  const beforeMeals = meals.slice(0, insertIdx).map((m) => m.name);
  const afterMeals = meals.slice(insertIdx).map((m) => m.name);
  return [...beforeMeals, '练前', '练后', ...afterMeals, '睡前'];
}

export function isSupplementPlan(content: string): boolean {
  const normalized = parseContent(content).toLowerCase();
  return SUPPLEMENT_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
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

    // Order matters: check 练前餐/练后餐 before 午餐/晚餐 to avoid partial match
    if (compactHeading.includes('练前餐') || compactHeading.includes('训练前餐') || plainMealHeading === '练前餐' || plainMealHeading === '训练前餐') {
      currentMeal = '练前餐';
      continue;
    }
    if (compactHeading.includes('练后餐') || compactHeading.includes('训练后餐') || plainMealHeading === '练后餐' || plainMealHeading === '训练后餐') {
      currentMeal = '练后餐';
      continue;
    }
    if (compactHeading.includes('早餐') || plainMealHeading === '早餐') {
      currentMeal = '早餐';
      continue;
    }
    if (compactHeading.includes('午餐') || plainMealHeading === '午餐') {
      currentMeal = '午餐';
      continue;
    }
    if (compactHeading.includes('晚餐') || plainMealHeading === '晚餐') {
      currentMeal = '晚餐';
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

    if (compactHeading.includes('补剂方案依据')) {
      mode = 'basis';
      currentSection = null;
      continue;
    }

    if (compactHeading.includes('总剂量与注意事项') || compactHeading.includes('注意事项')) {
      mode = 'notes';
      currentSection = null;
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

    const headingMatch = Object.keys(sectionMap).find((key) => compactHeading.includes(key));
    if (headingMatch || plainSectionHeading) {
      const key = (plainSectionHeading || headingMatch || '') as keyof typeof sectionMap;
      currentSection = sectionMap[key];
      mode = 'section';
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
