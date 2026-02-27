import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { api } from '../../services/api';
import { Card, EmptyState, Skeleton } from '../../components/ui';
import { CalendarPicker } from '../../components/CalendarPicker';
import { Spacing, Radius, FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { DietRecord, MealType } from '@shared/types';

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

const MEAL_ICONS: Record<MealType, keyof typeof Ionicons.glyphMap> = {
  breakfast: 'sunny-outline',
  lunch: 'restaurant-outline',
  dinner: 'moon-outline',
  snack: 'cafe-outline',
};

const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`;
}

export default function NutritionHistoryScreen() {
  const Colors = useThemeColor();
  const [records, setRecords] = useState<DietRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayStr);

  const fetchRecords = useCallback(async () => {
    try {
      const res = await api.getDietRecords();
      if (res.success && res.data) {
        setRecords(res.data as DietRecord[]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchRecords();
  };

  const markedDates = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      if (r.record_date) set.add(r.record_date);
    }
    return set;
  }, [records]);

  const selectedRecords = useMemo(
    () => records.filter((r) => r.record_date === selectedDate),
    [records, selectedDate]
  );

  const groupedMeals = useMemo(() => {
    const map = new Map<MealType, DietRecord[]>();
    for (const r of selectedRecords) {
      const list = map.get(r.meal_type) || [];
      list.push(r);
      map.set(r.meal_type, list);
    }
    return MEAL_ORDER
      .filter((m) => map.has(m))
      .map((m) => ({ mealType: m, records: map.get(m)! }));
  }, [selectedRecords]);

  const totals = useMemo(() => {
    let calories = 0, protein = 0, fat = 0, carbs = 0;
    for (const r of selectedRecords) {
      calories += r.calories || 0;
      protein += r.protein || 0;
      fat += r.fat || 0;
      carbs += r.carbs || 0;
    }
    return { calories, protein, fat, carbs };
  }, [selectedRecords]);

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: '饮食记录' }} />
        <View style={styles.content}>
          <View style={[styles.calendarSkeleton, { backgroundColor: Colors.surface, borderRadius: Radius.lg }]}>
            <Skeleton width="50%" height={20} borderRadius={4} style={{ alignSelf: 'center', marginBottom: 12 }} />
            <Skeleton width="100%" height={160} borderRadius={4} />
          </View>
          {[1, 2].map((i) => (
            <View key={i} style={[{ backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg }]}>
              <Skeleton width={80} height={16} borderRadius={4} style={{ marginBottom: 8 }} />
              <Skeleton width="100%" height={16} borderRadius={4} style={{ marginBottom: 6 }} />
              <Skeleton width="70%" height={16} borderRadius={4} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: '饮食记录' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.success} />}
      >
        <CalendarPicker
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          markedDates={markedDates}
          accentColor={Colors.success}
        />

        {selectedRecords.length === 0 ? (
          <EmptyState
            icon="nutrition-outline"
            title="该日无饮食记录"
            iconColor={Colors.success}
          />
        ) : (
          <Animated.View entering={FadeInDown.duration(300)}>
            <Card style={styles.recordCard}>
              {groupedMeals.map(({ mealType, records: mealRecords }, groupIdx) => (
                <View key={mealType}>
                  {groupIdx > 0 && <View style={[styles.divider, { backgroundColor: Colors.borderLight }]} />}
                  <View style={styles.mealHeader}>
                    <Ionicons name={MEAL_ICONS[mealType]} size={16} color={Colors.success} />
                    <Text style={[styles.mealLabel, { color: Colors.text }]}>{MEAL_LABELS[mealType]}</Text>
                  </View>
                  {mealRecords.map((record) => (
                    <View key={record.id} style={styles.mealItem}>
                      <Text style={[styles.foodDesc, { color: Colors.textSecondary }]} numberOfLines={2}>
                        {record.food_description}
                      </Text>
                      {record.calories != null && (
                        <Text style={[styles.kcalText, { color: Colors.textTertiary }]}>
                          {Math.round(record.calories)} kcal
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              ))}

              <View style={[styles.divider, { backgroundColor: Colors.border }]} />
              <View style={styles.totalsRow}>
                <Text style={[styles.totalLabel, { color: Colors.text }]}>合计</Text>
                <Text style={[styles.totalKcal, { color: Colors.success }]}>
                  {Math.round(totals.calories)} kcal
                </Text>
              </View>
              <View style={styles.macroRow}>
                <Text style={[styles.macroText, { color: Colors.textTertiary }]}>
                  蛋白质 {Math.round(totals.protein)}g{'  '}脂肪 {Math.round(totals.fat)}g{'  '}碳水 {Math.round(totals.carbs)}g
                </Text>
              </View>
            </Card>
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.lg },
  calendarSkeleton: { padding: Spacing.lg },
  recordCard: { padding: Spacing.lg },
  mealHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  mealLabel: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  mealItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: Spacing.xxl,
    marginBottom: Spacing.sm,
  },
  foodDesc: {
    fontSize: FontSize.sm,
    flex: 1,
    marginRight: Spacing.md,
  },
  kcalText: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    marginVertical: Spacing.md,
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    fontSize: FontSize.md,
    fontWeight: '700',
  },
  totalKcal: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  macroRow: {
    marginTop: Spacing.xs,
  },
  macroText: {
    fontSize: FontSize.sm,
  },
});
