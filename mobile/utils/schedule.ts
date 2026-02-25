import { parseContent } from './index';
import { LightColors } from '../constants';
import type { TrainingPlan, NutritionPlan } from '../../shared/types';

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

// ============ Slot metadata in time order ============

const SLOT_META: ScheduleSlotMeta[] = [
  { id: 'breakfast', label: '早餐', icon: 'sunny-outline', color: '#F59E0B' },
  { id: 'pre_workout', label: '练前', icon: 'flash-outline', color: '#8B5CF6' },
  { id: 'lunch', label: '午餐', icon: 'restaurant-outline', color: '#16A34A' },
  { id: 'training', label: '训练', icon: 'barbell-outline', color: LightColors.primary },
  { id: 'post_workout', label: '练后', icon: 'water-outline', color: '#0EA5E9' },
  { id: 'dinner', label: '晚餐', icon: 'moon-outline', color: '#EC4899' },
  { id: 'bedtime', label: '睡前', icon: 'bed-outline', color: '#6366F1' },
];

// ============ Supplement detection ============

const SUPPLEMENT_KEYWORDS = [
  '补剂', '蛋白粉', '乳清', '肌酸', '鱼油', '维生素',
  '矿物质', '电解质', 'bcaa', 'omega', '辅酶', '镁', '锌',
];

export function isSupplementPlan(content: string): boolean {
  const normalized = parseContent(content).toLowerCase();
  return SUPPLEMENT_KEYWORDS.some((kw) => normalized.includes(kw.toLowerCase()));
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

    if (compact.includes('早餐') || /^早餐\s*[：:]?\s*$/.test(line)) {
      currentMeal = '早餐';
      continue;
    }
    if (compact.includes('午餐') || /^午餐\s*[：:]?\s*$/.test(line)) {
      currentMeal = '午餐';
      continue;
    }
    if (compact.includes('晚餐') || /^晚餐\s*[：:]?\s*$/.test(line)) {
      currentMeal = '晚餐';
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

    // Skip non-section headings
    if (compact.includes('补剂方案依据') || compact.includes('总剂量与注意事项') || compact.includes('注意事项')) {
      mode = 'other';
      currentSection = null;
      continue;
    }

    const plainMatch = line.match(/^(早餐|午餐|练前|训练前|练后|训练后|晚餐|睡前)\s*[：:]?\s*$/)?.[1];
    const headingMatch = Object.keys(SECTION_MAP).find((key) => compact.includes(key));

    if (plainMatch || headingMatch) {
      const key = (plainMatch || headingMatch || '') as keyof typeof SECTION_MAP;
      currentSection = SECTION_MAP[key];
      mode = 'section';
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

export function buildDailySchedule(
  trainingPlan: TrainingPlan | null,
  nutritionPlans: NutritionPlan[]
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

  for (const meta of SLOT_META) {
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
