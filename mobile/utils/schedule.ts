import { parseContent } from './index';
import { LightColors } from '../constants';
import type { TrainingPlan, NutritionPlan } from '@shared/types';

// ============ Types ============

export type ScheduleSlotId =
  | 'breakfast'
  | 'pre_workout'
  | 'lunch'
  | 'training'
  | 'post_workout'
  | 'dinner'
  | 'bedtime';

export interface ScheduleSlotMeta {
  id: ScheduleSlotId;
  label: string;
  icon: string; // Ionicon name
  color: string;
}

export interface ScheduleContentItem {
  source: 'nutrition' | 'supplement' | 'training';
  sourceLabel: string;
  items: string[];
}

export interface ScheduleSlot {
  meta: ScheduleSlotMeta;
  content: ScheduleContentItem[];
  isEmpty: boolean;
}

export interface DailyScheduleLike {
  training_start_time?: string | null;
  breakfast_time?: string | null;
  lunch_time?: string | null;
  dinner_time?: string | null;
}

type TimedMealSlotId = 'breakfast' | 'lunch' | 'dinner';

const TIMED_MEAL_SLOT_ORDER: TimedMealSlotId[] = ['breakfast', 'lunch', 'dinner'];
const TIMED_MEAL_SLOT_INDEX: Record<TimedMealSlotId, number> = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
};
const FALLBACK_MEAL_SLOT_MINUTES: Record<TimedMealSlotId, number> = {
  breakfast: 8 * 60,
  lunch: 12 * 60,
  dinner: 19 * 60,
};

function isListItemLine(line: string): boolean {
  return /^[-*•]\s+/.test(line);
}

function isExplicitHeadingLine(line: string): boolean {
  if (isListItemLine(line)) return false;
  return /^#{1,6}\s*/.test(line) || /^\*\*.+\*\*$/.test(line) || /^\d+[.)、]\s*/.test(line);
}

// ============ Slot metadata in time order ============

const SLOT_META_BY_ID: Record<ScheduleSlotId, ScheduleSlotMeta> = {
  breakfast: { id: 'breakfast', label: '早餐', icon: 'sunny-outline', color: '#F59E0B' },
  pre_workout: { id: 'pre_workout', label: '练前', icon: 'flash-outline', color: '#8B5CF6' },
  lunch: { id: 'lunch', label: '午餐', icon: 'restaurant-outline', color: '#16A34A' },
  training: { id: 'training', label: '训练', icon: 'barbell-outline', color: LightColors.primary },
  post_workout: { id: 'post_workout', label: '练后', icon: 'water-outline', color: '#0EA5E9' },
  dinner: { id: 'dinner', label: '晚餐', icon: 'moon-outline', color: '#EC4899' },
  bedtime: { id: 'bedtime', label: '睡前', icon: 'bed-outline', color: '#6366F1' },
};

const DEFAULT_SLOT_ORDER: ScheduleSlotId[] = [
  'breakfast',
  'pre_workout',
  'lunch',
  'training',
  'post_workout',
  'dinner',
  'bedtime',
];

// ============ Supplement detection ============

const SUPPLEMENT_KEYWORDS = [
  '补剂', '蛋白粉', '乳清', '肌酸', '鱼油', '维生素',
  '矿物质', '电解质', 'bcaa', 'omega', '辅酶', '镁', '锌',
];

const SUPPLEMENT_PREFIX = '【补剂方案】';

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

export function isSupplementPlan(content: string): boolean {
  const normalized = parseContent(content).replace(/\r/g, '').trim();
  if (!normalized) return false;
  if (normalized.startsWith(SUPPLEMENT_PREFIX)) return true;
  if (/(^|\n)\s*(#{1,6}\s*)?补剂方案/.test(normalized)) return true;
  if (/(^|\n)\s*(#{1,6}\s*)?分时段补剂方案/.test(normalized)) return true;
  return hasLegacySupplementStructure(normalized);
}

// ============ Nutrition meal parsing ============

type MealName = '早餐' | '午餐' | '晚餐';

export function parseNutritionMeals(content: string): Record<MealName, string[]> {
  const text = parseContent(content).replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const meals: Record<MealName, string[]> = { 早餐: [], 午餐: [], 晚餐: [] };
  let currentMeal: MealName | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u3000/g, ' ').trim();
    if (!line) continue;

    const heading = line.replace(/^#{1,6}\s*/, '').replace(/[：:]\s*$/, '').trim();
    const compact = heading.replace(/\s+/g, '');
    const plainMealHeading = line.match(/^(早餐|午餐|晚餐)\s*[：:]?\s*$/)?.[1];
    const inlineMealHeading = parseInlineHeadingLine(line, ['早餐', '午餐', '晚餐'] as const);
    const canDetectHeading = isExplicitHeadingLine(line) || !!plainMealHeading || !!inlineMealHeading;

    if (canDetectHeading && (compact.includes('早餐') || plainMealHeading === '早餐')) {
      currentMeal = '早餐';
      if (inlineMealHeading && inlineMealHeading.heading === '早餐') {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }
    if (canDetectHeading && (compact.includes('午餐') || plainMealHeading === '午餐')) {
      currentMeal = '午餐';
      if (inlineMealHeading && inlineMealHeading.heading === '午餐') {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }
    if (canDetectHeading && (compact.includes('晚餐') || plainMealHeading === '晚餐')) {
      currentMeal = '晚餐';
      if (inlineMealHeading && inlineMealHeading.heading === '晚餐') {
        meals[currentMeal].push(inlineMealHeading.content);
      }
      continue;
    }

    // Other headings reset current meal context
    if (/^#{1,6}\s*/.test(line)) {
      currentMeal = null;
      continue;
    }

    if (!currentMeal) continue;

    const normalized = line
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .trim();
    if (normalized) meals[currentMeal].push(normalized);
  }

  return meals;
}

// ============ Supplement section parsing ============

type SupplementSectionName = '早餐' | '午餐' | '练前' | '练后' | '晚餐' | '睡前';

const SECTION_MAP: Record<string, SupplementSectionName> = {
  早餐: '早餐',
  午餐: '午餐',
  练前: '练前',
  训练前: '练前',
  练后: '练后',
  训练后: '练后',
  晚餐: '晚餐',
  睡前: '睡前',
};

export function parseSupplementSections(
  content: string
): Record<SupplementSectionName, string[]> {
  const text = parseContent(content).replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const sections: Record<SupplementSectionName, string[]> = {
    早餐: [], 午餐: [], 练前: [], 练后: [], 晚餐: [], 睡前: [],
  };
  let currentSection: SupplementSectionName | null = null;
  let mode: 'section' | 'other' | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u3000/g, ' ').trim();
    if (!line) continue;

    const heading = line.replace(/^#{1,6}\s*/, '').replace(/[：:]\s*$/, '').trim();
    const compact = heading.replace(/\s+/g, '');
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

    // Skip non-section headings
    if (
      canDetectHeading
      && (
        compact.includes('补剂方案依据')
        || compact.includes('总剂量与注意事项')
        || compact.includes('注意事项')
        || plainMetaHeading === '补剂方案依据'
        || plainMetaHeading === '总剂量与注意事项'
        || plainMetaHeading === '注意事项'
        || inlineMetaHeading?.heading === '补剂方案依据'
        || inlineMetaHeading?.heading === '总剂量与注意事项'
        || inlineMetaHeading?.heading === '注意事项'
      )
    ) {
      mode = 'other';
      currentSection = null;
      continue;
    }

    const detectedByHeading = canDetectHeading ? detectSupplementSectionByHeadingLine(line) : null;
    if (plainSectionHeading || detectedByHeading || inlineSectionHeading) {
      const headingKey = inlineSectionHeading?.heading ?? plainSectionHeading;
      const key = headingKey as keyof typeof SECTION_MAP;
      currentSection = headingKey ? SECTION_MAP[key] : detectedByHeading;
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

    if (mode !== 'section' || !currentSection) continue;

    const normalized = line
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .trim();
    if (normalized) sections[currentSection].push(normalized);
  }

  return sections;
}

// ============ Training parsing ============

export function parseTrainingSections(content: string): string[] {
  const raw = parseContent(content).replace(/\r/g, '');
  const firstSection = raw.indexOf('## ');
  const cleaned = firstSection >= 0 ? raw.slice(firstSection) : raw;

  const blocks = cleaned.split(/^## /m).filter((s) => s.trim());
  const result: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const title = lines[0].trim();
    const exercises: string[] = [];
    let current: string | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('### ')) {
        if (current) exercises.push(current);
        current = line.slice(4).trim();
      } else if (current && line.trim()) {
        const detail = line.replace(/^[-*•]\s*/, '').trim();
        if (detail) current += ` · ${detail}`;
      }
    }
    if (current) exercises.push(current);

    if (title && exercises.length > 0) {
      result.push(`【${title}】${exercises.join('，')}`);
    }
  }

  return result;
}

// ============ Build daily schedule ============

// Maps slot ids to the supplement section names
const SLOT_TO_SUPP: Partial<Record<ScheduleSlotId, SupplementSectionName>> = {
  breakfast: '早餐',
  pre_workout: '练前',
  lunch: '午餐',
  post_workout: '练后',
  dinner: '晚餐',
  bedtime: '睡前',
};

// Maps slot ids to the meal names
const SLOT_TO_MEAL: Partial<Record<ScheduleSlotId, MealName>> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
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

function buildOrderedSlotMeta(schedule?: DailyScheduleLike | null): ScheduleSlotMeta[] {
  const tMin = timeToMinutes(schedule?.training_start_time);
  if (tMin == null) {
    return DEFAULT_SLOT_ORDER.map((id) => SLOT_META_BY_ID[id]);
  }

  const meals = TIMED_MEAL_SLOT_ORDER
    .map((id) => {
      const parsed =
        id === 'breakfast'
          ? timeToMinutes(schedule?.breakfast_time)
          : id === 'lunch'
            ? timeToMinutes(schedule?.lunch_time)
            : timeToMinutes(schedule?.dinner_time);
      return { id, min: parsed ?? FALLBACK_MEAL_SLOT_MINUTES[id] };
    })
    .sort((a, b) => a.min - b.min || TIMED_MEAL_SLOT_INDEX[a.id] - TIMED_MEAL_SLOT_INDEX[b.id]);

  const insertIdx = (() => {
    const idx = meals.findIndex((m) => tMin <= m.min);
    return idx >= 0 ? idx : meals.length;
  })();

  const beforeMeals = meals.slice(0, insertIdx).map((m) => m.id);
  const afterMeals = meals.slice(insertIdx).map((m) => m.id);
  const order: ScheduleSlotId[] = [
    ...beforeMeals,
    'pre_workout',
    'training',
    'post_workout',
    ...afterMeals,
    'bedtime',
  ];

  return order.map((id) => SLOT_META_BY_ID[id]);
}

export function buildDailySchedule(
  trainingPlan: TrainingPlan | null,
  nutritionPlans: NutritionPlan[],
  schedule?: DailyScheduleLike | null
): ScheduleSlot[] {
  // Separate nutrition vs supplement plans, take latest of each
  const dietPlans = nutritionPlans.filter((p) => !isSupplementPlan(p.content));
  const suppPlans = nutritionPlans.filter((p) => isSupplementPlan(p.content));

  const latestDiet = dietPlans.length > 0 ? dietPlans[0] : null;
  const latestSupp = suppPlans.length > 0 ? suppPlans[0] : null;

  // Parse each
  const meals = latestDiet ? parseNutritionMeals(latestDiet.content) : null;
  const supps = latestSupp ? parseSupplementSections(latestSupp.content) : null;
  const training = trainingPlan ? parseTrainingSections(trainingPlan.content) : null;

  const slots: ScheduleSlot[] = [];

  const orderedSlotMeta = buildOrderedSlotMeta(schedule);
  for (const meta of orderedSlotMeta) {
    const contentItems: ScheduleContentItem[] = [];

    // Nutrition meals
    const mealKey = SLOT_TO_MEAL[meta.id];
    if (meals && mealKey && meals[mealKey].length > 0) {
      contentItems.push({
        source: 'nutrition',
        sourceLabel: '饮食',
        items: meals[mealKey],
      });
    }

    // Supplement sections
    const suppKey = SLOT_TO_SUPP[meta.id];
    if (supps && suppKey && supps[suppKey].length > 0) {
      contentItems.push({
        source: 'supplement',
        sourceLabel: '补剂',
        items: supps[suppKey],
      });
    }

    // Training slot
    if (meta.id === 'training' && training && training.length > 0) {
      contentItems.push({
        source: 'training',
        sourceLabel: '训练',
        items: training,
      });
    }

    // Only include slots with content
    if (contentItems.length > 0) {
      slots.push({ meta, content: contentItems, isEmpty: false });
    }
  }

  return slots;
}
