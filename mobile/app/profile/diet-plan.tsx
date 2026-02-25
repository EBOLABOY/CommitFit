import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { api } from '../../services/api';
import { Card, Button, EmptyState, Skeleton } from '../../components/ui';
import { Spacing, Radius, FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { NutritionPlan } from '../../../shared/types';
import { isSupplementPlan, parseStructuredNutritionPlan, MEAL_ORDER } from '../../utils/nutrition-plan';
import { parseContent } from '../../utils';

export default function DietPlanScreen() {
  const Colors = useThemeColor();
  const router = useRouter();
  const [plans, setPlans] = useState<NutritionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMeals, setExpandedMeals] = useState<Record<string, boolean>>({});

  const fetchPlans = useCallback(async () => {
    try {
      const res = await api.getNutritionPlans(30);
      if (res.success && res.data) {
        const allPlans = res.data as NutritionPlan[];
        setPlans(allPlans.filter((plan) => !isSupplementPlan(plan.content)));
      } else {
        setPlans([]);
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

  const sortedPlans = useMemo(
    () => [...plans].sort((a, b) => b.plan_date.localeCompare(a.plan_date)),
    [plans]
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
        <Stack.Screen options={{ headerShown: true, title: '饮食方案' }} />
        <View style={styles.content}>
          {[1, 2].map((i) => (
            <View key={i} style={[styles.planCard, { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg }]}>
              <Skeleton width={120} height={14} borderRadius={4} style={{ marginBottom: Spacing.md }} />
              <Skeleton width="100%" height={16} borderRadius={4} style={{ marginBottom: 6 }} />
              <Skeleton width="80%" height={16} borderRadius={4} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: '饮食方案' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.success} />}
      >
        <Button
          title="去 AI 生成饮食方案"
          icon="chatbubbles-outline"
          variant="outline"
          color={Colors.success}
          onPress={() => router.push('/(tabs)/ai')}
        />

        {sortedPlans.length === 0 ? (
          <EmptyState
            icon="nutrition-outline"
            title="暂无饮食方案"
            subtitle="在 AI 咨询中让营养师生成后，会自动同步到这里"
            iconColor={Colors.success}
          />
        ) : (
          sortedPlans.map((plan, index) => {
            const structured = parseStructuredNutritionPlan(plan.content);

            return (
              <Animated.View key={plan.id} entering={FadeInDown.duration(300).delay(index * 50)}>
                <Card style={styles.planCard}>
                  <View style={styles.planHeader}>
                    <View style={styles.planDate}>
                      <Ionicons name="calendar-outline" size={14} color={Colors.textTertiary} />
                      <Text style={[styles.dateText, { color: Colors.textTertiary }]}>{plan.plan_date}</Text>
                    </View>
                  </View>

                  {structured ? (
                    <View style={styles.planBlock}>
                      <View style={[styles.infoPanel, { backgroundColor: Colors.background, borderColor: Colors.borderLight }]}>
                        {structured.baseInfo && (
                          <Text style={[styles.infoLine, { color: Colors.textSecondary }]}>{structured.baseInfo}</Text>
                        )}
                        {structured.estimatedTdee && (
                          <Text style={[styles.infoLine, { color: Colors.info }]}>{structured.estimatedTdee}</Text>
                        )}
                        {structured.calorieTarget && (
                          <Text style={[styles.infoLine, { color: Colors.primary }]}>{structured.calorieTarget}</Text>
                        )}
                        {structured.macroTarget && (
                          <Text style={[styles.infoLine, { color: Colors.success }]}>{structured.macroTarget}</Text>
                        )}
                      </View>

                      {MEAL_ORDER.map((meal) => {
                        const mealItems = structured.meals[meal];
                        const isWorkoutMeal = meal === '练前餐' || meal === '练后餐';
                        // Main meals: hide if empty; workout meals: always show (collapsed if empty)
                        if (!isWorkoutMeal && mealItems.length === 0) return null;
                        const expanded = isSectionExpanded(plan.id, meal, meal === '早餐');

                        return (
                          <View key={`${plan.id}-${meal}`} style={[styles.sectionCard, { borderColor: Colors.borderLight }]}>
                            <TouchableOpacity
                              style={styles.sectionHeader}
                              onPress={() => toggleSection(plan.id, meal, meal === '早餐')}
                              activeOpacity={0.75}
                            >
                              <View style={styles.sectionTitleRow}>
                                <Text style={[styles.sectionTitle, { color: isWorkoutMeal ? Colors.primary : Colors.text }]}>{meal}</Text>
                                {isWorkoutMeal && mealItems.length === 0 && (
                                  <Text style={[styles.sectionHint, { color: Colors.textTertiary }]}>暂无</Text>
                                )}
                              </View>
                              <Ionicons
                                name={expanded ? 'chevron-up' : 'chevron-down'}
                                size={16}
                                color={Colors.textTertiary}
                              />
                            </TouchableOpacity>

                            {expanded && (
                              <View style={styles.sectionBody}>
                                {mealItems.length > 0 ? (
                                  mealItems.map((item, itemIndex) => (
                                    <Text key={`${plan.id}-${meal}-${itemIndex}`} style={[styles.sectionItem, { color: Colors.textSecondary }]}>
                                      {'\u2022'} {item}
                                    </Text>
                                  ))
                                ) : (
                                  <Text style={[styles.sectionItem, { color: Colors.textTertiary, fontStyle: 'italic' }]}>
                                    暂无{meal}安排
                                  </Text>
                                )}
                              </View>
                            )}
                          </View>
                        );
                      })}
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
  planBlock: { gap: Spacing.md },
  infoPanel: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  infoLine: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    fontWeight: '500',
  },
  sectionCard: {
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '600' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  sectionHint: { fontSize: FontSize.xs },
  sectionBody: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.md, gap: Spacing.xs },
  sectionItem: { fontSize: FontSize.sm, lineHeight: 20 },
});
