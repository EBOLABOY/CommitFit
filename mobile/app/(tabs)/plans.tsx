import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { api } from '../../services/api';
import { Card, EmptyState, Skeleton } from '../../components/ui';
import { Spacing, Radius, FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { parseContent } from '../../utils';
import type { NutritionPlan } from '../../../shared/types';

type NutritionTab = 'nutrition' | 'supplement';
type MealName = '早餐' | '午餐' | '晚餐';
type SupplementSectionName = '早餐' | '午餐' | '练前' | '练后' | '晚餐' | '睡前';

interface StructuredNutritionPlan {
  baseInfo?: string;
  estimatedTdee?: string;
  calorieTarget?: string;
  macroTarget?: string;
  meals: Record<MealName, string[]>;
}

interface StructuredSupplementPlan {
  basis: string[];
  notes: string[];
  sections: Record<SupplementSectionName, string[]>;
}

const SUPPLEMENT_KEYWORDS = [
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

const MEAL_ORDER: MealName[] = ['早餐', '午餐', '晚餐'];
const SUPPLEMENT_SECTION_ORDER: SupplementSectionName[] = ['早餐', '午餐', '练前', '练后', '晚餐', '睡前'];

function isSupplementPlan(content: string) {
  const normalized = parseContent(content).toLowerCase();
  return SUPPLEMENT_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function parseStructuredNutritionPlan(content: string): StructuredNutritionPlan | null {
  const text = parseContent(content).replace(/\r/g, '');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const meals: Record<MealName, string[]> = {
    早餐: [],
    午餐: [],
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
    const plainMealHeading = line.match(/^(早餐|午餐|晚餐)\s*[：:]?\s*$/)?.[1] as MealName | undefined;

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

function parseStructuredSupplementPlan(content: string): StructuredSupplementPlan | null {
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

export default function PlansScreen() {
  const Colors = useThemeColor();
  const [tab, setTab] = useState<NutritionTab>('nutrition');
  const [nutritionPlans, setNutritionPlans] = useState<NutritionPlan[]>([]);
  const [expandedMeals, setExpandedMeals] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchPlans = useCallback(async () => {
    try {
      const res = await api.getNutritionPlans(30);
      if (res.success && res.data) {
        setNutritionPlans(res.data as NutritionPlan[]);
      } else {
        setNutritionPlans([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchPlans();
  };

  const supplementPlans = useMemo(
    () => nutritionPlans.filter((plan) => isSupplementPlan(plan.content)),
    [nutritionPlans]
  );

  const displayPlans = useMemo(
    () => (tab === 'nutrition' ? nutritionPlans : supplementPlans),
    [tab, nutritionPlans, supplementPlans]
  );

  const isSectionExpanded = useCallback((planId: string, section: string, defaultExpanded = false) => {
    const key = `${planId}:${section}`;
    if (expandedMeals[key] !== undefined) return expandedMeals[key];
    return defaultExpanded;
  }, [expandedMeals]);

  const toggleSection = useCallback((planId: string, section: string, defaultExpanded = false) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedMeals((prev) => {
      const key = `${planId}:${section}`;
      const current = prev[key] !== undefined ? prev[key] : defaultExpanded;
      return { ...prev, [key]: !current };
    });
  }, []);

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.background }]}>
        <View style={[styles.tabBar, { backgroundColor: Colors.surface, borderBottomColor: Colors.borderLight }]}>
          <View style={[styles.tabItem, { borderBottomColor: Colors.primary }]}>
            <Skeleton width={84} height={18} borderRadius={4} />
          </View>
          <View style={styles.tabItem}>
            <Skeleton width={84} height={18} borderRadius={4} />
          </View>
        </View>
        <View style={styles.content}>
          {[1, 2, 3].map((i) => (
            <View key={i} style={[styles.planCard, { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg }]}>
              <Skeleton width={120} height={14} borderRadius={4} style={{ marginBottom: Spacing.md }} />
              <Skeleton width="100%" height={16} borderRadius={4} style={{ marginBottom: 6 }} />
              <Skeleton width="82%" height={16} borderRadius={4} style={{ marginBottom: 6 }} />
              <Skeleton width="66%" height={16} borderRadius={4} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.background }]}>
      <View style={styles.headerBlock}>
        <Text style={[styles.pageDesc, { color: Colors.textSecondary }]}>把饮食与补剂建议整理成清晰方案</Text>
      </View>

      <View style={[styles.tabBar, { backgroundColor: Colors.surface, borderBottomColor: Colors.borderLight }]}>
        <TouchableOpacity
          style={[styles.tabItem, tab === 'nutrition' && { borderBottomColor: Colors.primary }]}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setTab('nutrition');
          }}
          accessibilityLabel="饮食方案"
          accessibilityRole="tab"
        >
          <Ionicons name="nutrition" size={18} color={tab === 'nutrition' ? Colors.primary : Colors.textTertiary} />
          <Text style={[styles.tabText, { color: tab === 'nutrition' ? Colors.primary : Colors.textTertiary }]}>饮食方案</Text>
          {nutritionPlans.length > 0 && (
            <View style={[styles.tabBadge, tab === 'nutrition' && { backgroundColor: Colors.primary }]}>
              <Text style={styles.tabBadgeText}>{nutritionPlans.length}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, tab === 'supplement' && { borderBottomColor: Colors.primary }]}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setTab('supplement');
          }}
          accessibilityLabel="补剂方案"
          accessibilityRole="tab"
        >
          <Ionicons name="medkit-outline" size={18} color={tab === 'supplement' ? Colors.primary : Colors.textTertiary} />
          <Text style={[styles.tabText, { color: tab === 'supplement' ? Colors.primary : Colors.textTertiary }]}>补剂方案</Text>
          {supplementPlans.length > 0 && (
            <View style={[styles.tabBadge, tab === 'supplement' && { backgroundColor: Colors.primary }]}>
              <Text style={styles.tabBadgeText}>{supplementPlans.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.primary} />}
      >
        {displayPlans.length === 0 ? (
          <EmptyState
            icon={tab === 'nutrition' ? 'nutrition-outline' : 'medkit-outline'}
            title={tab === 'nutrition' ? '暂无饮食方案' : '暂无补剂方案'}
            subtitle={
              tab === 'nutrition'
                ? '和营养师 AI 对话后，饮食方案会出现在这里'
                : '当前未识别到补剂相关方案，可在 AI 对话中补充补剂需求'
            }
            iconColor={tab === 'nutrition' ? Colors.success : Colors.warning}
          />
        ) : (
          displayPlans.map((plan, index) => {
            const structuredNutrition = tab === 'nutrition' ? parseStructuredNutritionPlan(plan.content) : null;
            const structuredSupplement = tab === 'supplement' ? parseStructuredSupplementPlan(plan.content) : null;

            return (
              <Animated.View key={plan.id} entering={FadeInDown.duration(300).delay(index * 60)}>
                <Card style={styles.planCard}>
                  <View style={styles.planHeader}>
                    <View style={styles.planDate}>
                      <Ionicons name="calendar-outline" size={14} color={Colors.textTertiary} />
                      <Text style={[styles.dateText, { color: Colors.textTertiary }]}>{plan.plan_date}</Text>
                    </View>
                    {tab === 'supplement' && (
                      <View style={[styles.badge, { backgroundColor: Colors.warningLight }]}>
                        <Text style={[styles.badgeText, { color: Colors.warning }]}>补剂</Text>
                      </View>
                    )}
                  </View>

                  {structuredNutrition ? (
                    <View style={styles.nutritionBlock}>
                      <View style={[styles.caloriePanel, { backgroundColor: Colors.background, borderColor: Colors.borderLight }]}>
                        {structuredNutrition.baseInfo && (
                          <Text style={[styles.calorieLine, { color: Colors.textSecondary }]}>{structuredNutrition.baseInfo}</Text>
                        )}
                        {structuredNutrition.estimatedTdee && (
                          <Text style={[styles.calorieLine, { color: Colors.info }]}>{structuredNutrition.estimatedTdee}</Text>
                        )}
                        {structuredNutrition.calorieTarget && (
                          <Text style={[styles.calorieLine, { color: Colors.primary }]}>{structuredNutrition.calorieTarget}</Text>
                        )}
                        {structuredNutrition.macroTarget && (
                          <Text style={[styles.calorieLine, { color: Colors.success }]}>{structuredNutrition.macroTarget}</Text>
                        )}
                      </View>

                      {MEAL_ORDER.map((meal) => {
                        const mealItems = structuredNutrition.meals[meal];
                        if (mealItems.length === 0) return null;
                        const expanded = isSectionExpanded(plan.id, meal, meal === '早餐');

                        return (
                          <View key={`${plan.id}-${meal}`} style={[styles.mealSection, { borderColor: Colors.borderLight }]}>
                            <TouchableOpacity
                              style={styles.mealHeader}
                              onPress={() => toggleSection(plan.id, meal, meal === '早餐')}
                              activeOpacity={0.75}
                              accessibilityLabel={`${meal}${expanded ? '收起' : '展开'}`}
                            >
                              <Text style={[styles.mealTitle, { color: Colors.text }]}>{meal}</Text>
                              <Ionicons
                                name={expanded ? 'chevron-up' : 'chevron-down'}
                                size={16}
                                color={Colors.textTertiary}
                              />
                            </TouchableOpacity>

                            {expanded && (
                              <View style={styles.mealBody}>
                                {mealItems.map((item, itemIndex) => (
                                  <Text key={`${plan.id}-${meal}-${itemIndex}`} style={[styles.mealItemText, { color: Colors.textSecondary }]}>
                                    {'\u2022'} {item}
                                  </Text>
                                ))}
                              </View>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  ) : structuredSupplement ? (
                    <View style={styles.nutritionBlock}>
                      {structuredSupplement.basis.length > 0 && (
                        <View style={[styles.caloriePanel, { backgroundColor: Colors.background, borderColor: Colors.borderLight }]}>
                          {structuredSupplement.basis.map((line, lineIndex) => (
                            <Text key={`${plan.id}-basis-${lineIndex}`} style={[styles.calorieLine, { color: Colors.textSecondary }]}>
                              {line}
                            </Text>
                          ))}
                        </View>
                      )}

                      {SUPPLEMENT_SECTION_ORDER.map((section) => {
                        const sectionItems = structuredSupplement.sections[section];
                        if (sectionItems.length === 0) return null;
                        const expanded = isSectionExpanded(plan.id, section, section === '早餐' || section === '练前');

                        return (
                          <View key={`${plan.id}-${section}`} style={[styles.mealSection, { borderColor: Colors.borderLight }]}>
                            <TouchableOpacity
                              style={styles.mealHeader}
                              onPress={() => toggleSection(plan.id, section, section === '早餐' || section === '练前')}
                              activeOpacity={0.75}
                              accessibilityLabel={`${section}${expanded ? '收起' : '展开'}`}
                            >
                              <Text style={[styles.mealTitle, { color: Colors.text }]}>{section}</Text>
                              <Ionicons
                                name={expanded ? 'chevron-up' : 'chevron-down'}
                                size={16}
                                color={Colors.textTertiary}
                              />
                            </TouchableOpacity>

                            {expanded && (
                              <View style={styles.mealBody}>
                                {sectionItems.map((item, itemIndex) => (
                                  <Text key={`${plan.id}-${section}-${itemIndex}`} style={[styles.mealItemText, { color: Colors.textSecondary }]}>
                                    {'\u2022'} {item}
                                  </Text>
                                ))}
                              </View>
                            )}
                          </View>
                        );
                      })}

                      {structuredSupplement.notes.length > 0 && (
                        <View style={[styles.caloriePanel, { backgroundColor: Colors.background, borderColor: Colors.borderLight }]}>
                          {structuredSupplement.notes.map((line, lineIndex) => (
                            <Text key={`${plan.id}-note-${lineIndex}`} style={[styles.calorieLine, { color: Colors.warning }]}>
                              {line}
                            </Text>
                          ))}
                        </View>
                      )}
                    </View>
                  ) : (
                    <Text style={[styles.planContent, { color: Colors.text }]} numberOfLines={12}>
                      {parseContent(plan.content)}
                    </Text>
                  )}
                </Card>
              </Animated.View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerBlock: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  pageDesc: { fontSize: FontSize.sm, marginTop: 2 },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    borderBottomWidth: 1,
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: { fontSize: FontSize.md, fontWeight: '500' },
  tabBadge: {
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.xs,
    paddingVertical: 1,
    minWidth: 20,
    alignItems: 'center',
  },
  tabBadgeText: { fontSize: 10, fontWeight: '600', color: '#FFFFFF' },

  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: 40 },

  planCard: { padding: Spacing.lg },
  planHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  planDate: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  dateText: { fontSize: FontSize.sm },
  planContent: { fontSize: FontSize.md, lineHeight: 24 },
  nutritionBlock: { gap: Spacing.md },
  caloriePanel: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  calorieLine: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    fontWeight: '500',
  },
  mealSection: {
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  mealHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  mealTitle: { fontSize: FontSize.md, fontWeight: '600' },
  mealBody: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.md, gap: Spacing.xs },
  mealItemText: { fontSize: FontSize.sm, lineHeight: 20 },
  badge: {
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  badgeText: { fontSize: FontSize.xs, fontWeight: '700' },
});
