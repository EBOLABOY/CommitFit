import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { api } from '../../services/api';
import { Card, Badge, EmptyState, Skeleton } from '../../components/ui';
import { CalendarPicker } from '../../components/CalendarPicker';
import { Spacing, Radius, FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { parseContent } from '../../utils';
import type { TrainingPlan } from '../../../shared/types';

// --- Plan parsing (same as home page) ---

interface PlanExercise {
  name: string;
  details: string;
}

interface PlanSection {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  exercises: PlanExercise[];
}

const SECTION_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  '热身激活': 'body-outline',
  '正式训练': 'barbell-outline',
  '静态放松': 'leaf-outline',
};

function parsePlanSections(content: string): PlanSection[] | null {
  const raw = parseContent(content);

  const firstSection = raw.indexOf('## ');
  const cleaned = firstSection >= 0 ? raw.slice(firstSection) : raw;
  const trimmed = cleaned.replace(/\n(?!##|###|- )(?!$)[^#\n-].*$/gm, (match, offset) => {
    const line = match.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) return match;
    const after = cleaned.slice(offset);
    if (!after.includes('\n### ')) return '';
    return match;
  });

  const blocks = trimmed.split(/^## /m).filter((s) => s.trim());
  if (blocks.length === 0) return null;

  const sections: PlanSection[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const title = lines[0].trim();
    const icon = SECTION_ICONS[title] || 'list-outline';
    const exercises: PlanExercise[] = [];
    let current: PlanExercise | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('### ')) {
        if (current) exercises.push(current);
        current = { name: line.slice(4).trim(), details: '' };
      } else if (current && line.trim()) {
        current.details += (current.details ? '\n' : '') + line;
      }
    }
    if (current) exercises.push(current);
    if (title && exercises.length > 0) {
      sections.push({ title, icon, exercises });
    }
  }

  return sections.length > 0 ? sections : null;
}

// --- Helpers ---

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`;
}

export default function TrainingHistoryScreen() {
  const Colors = useThemeColor();
  const [plans, setPlans] = useState<TrainingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayStr);

  // Collapsible exercise state: stores "planId-sectionIdx-exerciseIdx" keys
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExercise = useCallback((key: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const sectionColors = useMemo(
    () => [Colors.warning, Colors.primary, Colors.success],
    [Colors]
  );

  const fetchPlans = useCallback(async () => {
    try {
      const res = await api.getTrainingPlans(60);
      if (res.success && res.data) {
        setPlans(res.data as TrainingPlan[]);
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
    setExpanded(new Set());
    fetchPlans();
  };

  const markedDates = useMemo(() => {
    const set = new Set<string>();
    for (const p of plans) {
      if (p.plan_date) set.add(p.plan_date);
    }
    return set;
  }, [plans]);

  const selectedPlans = useMemo(
    () => plans.filter((p) => p.plan_date === selectedDate),
    [plans, selectedDate]
  );

  const handleComplete = (plan: TrainingPlan) => {
    if (plan.completed) return;
    Alert.alert('标记完成', '确定将此训练计划标记为已完成吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '完成',
        onPress: async () => {
          await api.completeTrainingPlan(plan.id);
          setPlans((prev) =>
            prev.map((p) => (p.id === plan.id ? { ...p, completed: 1 } : p))
          );
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: '训练记录' }} />
        <View style={styles.content}>
          <View style={[styles.calendarSkeleton, { backgroundColor: Colors.surface, borderRadius: Radius.lg }]}>
            <Skeleton width="50%" height={20} borderRadius={4} style={{ alignSelf: 'center', marginBottom: 12 }} />
            <Skeleton width="100%" height={160} borderRadius={4} />
          </View>
          {[1, 2].map((i) => (
            <View key={i} style={[{ backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg }]}>
              <Skeleton width={100} height={16} borderRadius={4} style={{ marginBottom: 8 }} />
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
      <Stack.Screen options={{ headerShown: true, title: '训练记录' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.primary} />}
      >
        <CalendarPicker
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          markedDates={markedDates}
          accentColor={Colors.primary}
        />

        {selectedPlans.length === 0 ? (
          <EmptyState
            icon="barbell-outline"
            title="该日无训练记录"
            iconColor={Colors.primary}
          />
        ) : (
          selectedPlans.map((plan, index) => {
            const sections = parsePlanSections(plan.content);
            return (
              <Animated.View key={plan.id} entering={FadeInDown.duration(300).delay(index * 60)}>
                <Card style={styles.planCard}>
                  <View style={styles.planHeader}>
                    <View style={styles.planDate}>
                      <Ionicons name="calendar-outline" size={14} color={Colors.textTertiary} />
                      <Text style={[styles.dateText, { color: Colors.textTertiary }]}>{plan.plan_date}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleComplete(plan)}
                      disabled={!!plan.completed}
                      activeOpacity={0.6}
                      accessibilityLabel={plan.completed ? '已完成' : '标记为完成'}
                      accessibilityRole="button"
                    >
                      <Badge
                        label={plan.completed ? '已完成' : '标记完成'}
                        color={plan.completed ? Colors.success : Colors.primary}
                      />
                    </TouchableOpacity>
                  </View>

                  {sections ? (
                    sections.map((section, si) => {
                      const color = sectionColors[si % sectionColors.length];
                      return (
                        <View key={si} style={si > 0 ? styles.section : styles.sectionFirst}>
                          <View style={styles.sectionLabel}>
                            <View style={[styles.sectionDot, { backgroundColor: color }]} />
                            <Text style={[styles.sectionTitle, { color: Colors.textSecondary }]}>{section.title}</Text>
                          </View>
                          {section.exercises.map((ex, ei) => {
                            const key = `${plan.id}-${si}-${ei}`;
                            const isOpen = expanded.has(key);
                            return (
                              <TouchableOpacity
                                key={key}
                                style={styles.exerciseItem}
                                onPress={() => toggleExercise(key)}
                                activeOpacity={0.7}
                              >
                                <View style={styles.exerciseRow}>
                                  <Text style={[styles.exerciseName, { color: Colors.text }]}>{ex.name}</Text>
                                  <Ionicons
                                    name={isOpen ? 'chevron-up' : 'chevron-down'}
                                    size={14}
                                    color={Colors.textTertiary}
                                  />
                                </View>
                                {isOpen && (
                                  <Text style={[styles.exerciseDetails, { color: Colors.textSecondary }]}>
                                    {ex.details.replace(/^- /gm, '').trim()}
                                  </Text>
                                )}
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      );
                    })
                  ) : (
                    <Text style={[styles.fallbackText, { color: Colors.text }]}>{parseContent(plan.content)}</Text>
                  )}

                  {plan.notes && (
                    <View style={[styles.notesContainer, { borderTopColor: Colors.borderLight }]}>
                      <Text style={[styles.notesLabel, { color: Colors.textTertiary }]}>备注</Text>
                      <Text style={[styles.notesText, { color: Colors.textSecondary }]}>{plan.notes}</Text>
                    </View>
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
  content: { padding: Spacing.xl, gap: Spacing.lg },
  calendarSkeleton: { padding: Spacing.lg },
  planCard: { padding: Spacing.lg, borderLeftWidth: 3, borderLeftColor: '#FF6B35' },
  planHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  planDate: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  dateText: { fontSize: FontSize.sm },

  // Structured sections (matches home page)
  sectionFirst: { marginBottom: Spacing.sm },
  section: { marginTop: Spacing.md, marginBottom: Spacing.sm },
  sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.xs },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '600' },

  exerciseItem: { paddingVertical: Spacing.sm, paddingLeft: Spacing.md },
  exerciseRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  exerciseName: { fontSize: FontSize.md, fontWeight: '500', flex: 1, marginRight: Spacing.sm },
  exerciseDetails: { fontSize: FontSize.sm, lineHeight: 20, marginTop: 4, paddingLeft: 2 },

  // Fallback for old-format plans
  fallbackText: { fontSize: FontSize.md, lineHeight: 24 },

  notesContainer: { marginTop: Spacing.md, paddingTop: Spacing.md, borderTopWidth: 1 },
  notesLabel: { fontSize: FontSize.xs, fontWeight: '600', marginBottom: Spacing.xs },
  notesText: { fontSize: FontSize.sm },
});
