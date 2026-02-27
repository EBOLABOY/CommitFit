import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  withDelay,
  withRepeat,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../stores/auth';
import { useProfileStore } from '../../stores/profile';
import { useWritebackOutboxStore } from '../../stores/writeback-outbox';
import { SectionHeader, Card, EmptyState, Skeleton, ProgressRing, GradientButton } from '../../components/ui';
import { Spacing, Radius, FontSize, Shadows, Gradients } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { api } from '../../services/api';
import { WeightChartModal } from '../../components/WeightChartModal';
import { buildDailySchedule } from '../../utils/schedule';
import type { ScheduleSlot, ScheduleSlotId } from '../../utils/schedule';
import type { TrainingPlan, NutritionPlan, DietRecord, MealType, DailyLog } from '@shared/types';
import type { ThemeColors } from '../../constants';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

function getTodayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCurrentMealType(): MealType {
  const hour = new Date().getHours();
  if (hour < 10) return 'breakfast';
  if (hour < 14) return 'lunch';
  if (hour < 17) return 'snack';
  return 'dinner';
}

const COMPLETION_KEY_PREFIX = 'schedule_completed_';

function getCompletionKey(dateStr: string) {
  return `${COMPLETION_KEY_PREFIX}${dateStr}`;
}

// ============ Source badge colors ============

function getSourceColor(sourceLabel: string, themeColors: ThemeColors): string {
  if (sourceLabel === '饮食') return themeColors.success;
  if (sourceLabel === '补剂') return '#8B5CF6';
  if (sourceLabel === '训练') return themeColors.primary;
  return themeColors.primary;
}

// ============ ScheduleSlotRow Component ============

interface ScheduleSlotRowProps {
  slot: ScheduleSlot;
  isExpanded: boolean;
  isCompleted: boolean;
  onToggle: () => void;
  onComplete: () => void;
  themeColors: ThemeColors;
  index: number;
}

function ScheduleSlotRow({
  slot,
  isExpanded,
  isCompleted,
  onToggle,
  onComplete,
  themeColors,
  index,
}: ScheduleSlotRowProps) {
  const flashOpacity = useSharedValue(0);
  const checkScale = useSharedValue(isCompleted ? 1 : 0);
  const rowOpacity = useSharedValue(isCompleted ? 0.55 : 1);
  const hasAnimated = useRef(isCompleted);

  // Sync if completion state was loaded from storage
  useEffect(() => {
    if (isCompleted && !hasAnimated.current) {
      checkScale.value = 1;
      rowOpacity.value = 0.55;
      hasAnimated.current = true;
    }
  }, [isCompleted, checkScale, rowOpacity]);

  const handleLongPress = useCallback(() => {
    if (isCompleted) return;
    hasAnimated.current = true;

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // Green flash
    flashOpacity.value = withSequence(
      withTiming(0.3, { duration: 150 }),
      withTiming(0, { duration: 400 })
    );

    // Check scale bounce
    checkScale.value = withSequence(
      withTiming(1.2, { duration: 200, easing: Easing.back(2) }),
      withTiming(1.0, { duration: 150 })
    );

    // Row fade
    rowOpacity.value = withDelay(
      300,
      withTiming(0.55, { duration: 300 })
    );

    runOnJS(onComplete)();
  }, [isCompleted, flashOpacity, checkScale, rowOpacity, onComplete]);

  const flashStyle = useAnimatedStyle(() => ({
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#22C55E',
    borderRadius: Radius.lg,
    opacity: flashOpacity.value,
  }));

  const checkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: checkScale.value }],
  }));

  const rowAnimatedStyle = useAnimatedStyle(() => ({
    opacity: rowOpacity.value,
  }));

  const previewText = slot.content
    .map((c) => c.items[0])
    .filter(Boolean)
    .join('；');

  return (
    <Animated.View
      entering={FadeInDown.duration(250).delay(index * 50)}
      style={rowAnimatedStyle}
    >
      <TouchableOpacity
        style={[slotStyles.row, { backgroundColor: themeColors.surface }]}
        onPress={onToggle}
        onLongPress={handleLongPress}
        delayLongPress={500}
        activeOpacity={0.7}
      >
        {/* Green flash overlay */}
        <Animated.View style={flashStyle} pointerEvents="none" />

        <View style={slotStyles.rowInner}>
          {/* Left icon */}
          <Animated.View style={checkStyle}>
            <View
              style={[
                slotStyles.iconCircle,
                {
                  backgroundColor: isCompleted
                    ? '#22C55E' + '22'
                    : slot.meta.color + '18',
                },
              ]}
            >
              <Ionicons
                name={
                  isCompleted
                    ? 'checkmark'
                    : (slot.meta.icon as keyof typeof Ionicons.glyphMap)
                }
                size={18}
                color={isCompleted ? '#22C55E' : slot.meta.color}
              />
            </View>
          </Animated.View>

          {/* Center content */}
          <View style={slotStyles.centerContent}>
            <View style={slotStyles.labelRow}>
              <Text
                style={[
                  slotStyles.slotLabel,
                  { color: themeColors.text },
                  isCompleted && slotStyles.completedLabel,
                ]}
              >
                {slot.meta.label}
              </Text>
              {slot.content.map((c) => {
                const sourceColor = getSourceColor(c.sourceLabel, themeColors);
                return (
                  <View
                    key={c.sourceLabel}
                    style={[
                      slotStyles.sourceBadge,
                      { backgroundColor: sourceColor + '18' },
                    ]}
                  >
                    <Text
                      style={[
                        slotStyles.sourceBadgeText,
                        { color: sourceColor },
                      ]}
                    >
                      {c.sourceLabel}
                    </Text>
                  </View>
                );
              })}
            </View>
            {!isExpanded && (
              <Text
                style={[slotStyles.previewText, { color: themeColors.textTertiary }]}
                numberOfLines={1}
              >
                {previewText}
              </Text>
            )}
          </View>

          {/* Right arrow */}
          <Ionicons
            name={isExpanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={themeColors.textTertiary}
          />
        </View>

        {/* Expanded details */}
        {isExpanded && (
          <View style={[slotStyles.expandedBody, { borderTopColor: themeColors.borderLight }]}>
            {slot.content.map((contentItem) => (
              <View key={contentItem.sourceLabel} style={slotStyles.sourceGroup}>
                <Text
                  style={[
                    slotStyles.sourceGroupLabel,
                    { color: getSourceColor(contentItem.sourceLabel, themeColors) },
                  ]}
                >
                  {contentItem.sourceLabel}
                </Text>
                {contentItem.items.map((item, i) => (
                  <Text
                    key={i}
                    style={[slotStyles.itemText, { color: themeColors.textSecondary }]}
                  >
                    {'\u2022'} {item}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const slotStyles = StyleSheet.create({
  row: {
    borderRadius: Radius.lg,
    marginBottom: Spacing.sm,
    overflow: 'hidden',
    ...Shadows.sm,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    gap: Spacing.md,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerContent: {
    flex: 1,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  slotLabel: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  completedLabel: {
    textDecorationLine: 'line-through',
    opacity: 0.6,
  },
  sourceBadge: {
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 1,
  },
  sourceBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  previewText: {
    fontSize: FontSize.sm,
    marginTop: 2,
  },
  expandedBody: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    borderTopWidth: 1,
    marginHorizontal: Spacing.sm,
    paddingTop: Spacing.sm,
  },
  sourceGroup: {
    marginBottom: Spacing.sm,
  },
  sourceGroupLabel: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    marginBottom: Spacing.xs,
    textTransform: 'uppercase',
  },
  itemText: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    marginLeft: Spacing.xs,
  },
});

// ============ HeroAvatar (呼吸光晕) ============

function HeroAvatar({ nickname }: { nickname?: string | null }) {
  const glowScale = useSharedValue(1);
  const glowOpacity = useSharedValue(0.4);

  useEffect(() => {
    glowScale.value = withRepeat(
      withTiming(1.4, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    glowOpacity.value = withRepeat(
      withTiming(0.1, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, [glowScale, glowOpacity]);

  const glowStyle = useAnimatedStyle(() => ({
    transform: [{ scale: glowScale.value }],
    opacity: glowOpacity.value,
  }));

  return (
    <View style={heroAvatarStyles.container}>
      <Animated.View style={[heroAvatarStyles.glow, glowStyle]} />
      <View style={heroAvatarStyles.circle}>
        <Text style={heroAvatarStyles.text}>{(nickname || '练')[0]}</Text>
      </View>
    </View>
  );
}

const heroAvatarStyles = StyleSheet.create({
  container: { width: 52, height: 52, justifyContent: 'center', alignItems: 'center' },
  glow: {
    position: 'absolute',
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  circle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    fontSize: FontSize.xl,
    fontWeight: '700',
    color: '#FFF',
  },
});

// ============ HomeScreen ============

export default function HomeScreen() {
  const router = useRouter();
  const themeColors = useThemeColor();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const profile = useProfileStore((s) => s.profile);
  const fetchProfile = useProfileStore((s) => s.fetchProfile);
  const lastCommitted = useWritebackOutboxStore((s) => s.lastCommitted);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Plan states
  const [todayPlan, setTodayPlan] = useState<TrainingPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);

  // Nutrition plan states (for schedule)
  const [nutritionPlans, setNutritionPlans] = useState<NutritionPlan[]>([]);
  const [nutritionLoading, setNutritionLoading] = useState(true);

  // Diet states
  const [dietRecords, setDietRecords] = useState<DietRecord[]>([]);
  const [dietLoading, setDietLoading] = useState(true);

  // Daily log states (weight & sleep)
  const [dailyLog, setDailyLog] = useState<DailyLog | null>(null);
  const [dailyLogLoading, setDailyLogLoading] = useState(true);
  const [weightInput, setWeightInput] = useState('');
  const [sleepInput, setSleepInput] = useState('');
  const [isSavingLog, setIsSavingLog] = useState(false);
  const [editingLog, setEditingLog] = useState<'weight' | 'sleep' | null>(null);
  const [weightChartVisible, setWeightChartVisible] = useState(false);

  // Schedule states
  const [expandedSlots, setExpandedSlots] = useState<Set<ScheduleSlotId>>(new Set());
  const [completedSlots, setCompletedSlots] = useState<Record<string, boolean>>({});

  const today = useMemo(() => {
    const d = new Date();
    return `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}`;
  }, []);

  const todayDateStr = useMemo(() => getTodayDate(), []);

  // ---- Data fetching ----

  const fetchTrainingOverview = useCallback(async () => {
    try {
      const res = await api.getTrainingPlans(5);
      if (res.success && res.data) {
        const plans = res.data as TrainingPlan[];
        const found = plans.find((p) => p.plan_date === todayDateStr);
        setTodayPlan(found || null);
      } else {
        setTodayPlan(null);
      }
    } finally {
      setPlanLoading(false);
    }
  }, [todayDateStr]);

  const fetchNutritionOverview = useCallback(async () => {
    try {
      const res = await api.getNutritionPlans(10);
      if (res.success && res.data) {
        const all = res.data as NutritionPlan[];
        // Filter to today's plans
        const todayPlans = all.filter((p) => p.plan_date === todayDateStr);
        // If none for today, use the latest plans as general guidance
        setNutritionPlans(todayPlans.length > 0 ? todayPlans : all.slice(0, 2));
      } else {
        setNutritionPlans([]);
      }
    } catch {
      setNutritionPlans([]);
    } finally {
      setNutritionLoading(false);
    }
  }, [todayDateStr]);

  const fetchDietRecords = useCallback(async () => {
    try {
      const res = await api.getDietRecords(todayDateStr);
      if (res.success && res.data) {
        setDietRecords(res.data as DietRecord[]);
      } else {
        setDietRecords([]);
      }
    } catch {
      setDietRecords([]);
    } finally {
      setDietLoading(false);
    }
  }, [todayDateStr]);

  const fetchDailyLog = useCallback(async () => {
    try {
      const res = await api.getDailyLog(todayDateStr);
      if (res.success && res.data) {
        const log = res.data as DailyLog;
        setDailyLog(log);
        if (log.weight != null) setWeightInput(String(log.weight));
        if (log.sleep_hours != null) setSleepInput(String(log.sleep_hours));
      }
    } catch {
      // ignore
    } finally {
      setDailyLogLoading(false);
    }
  }, [todayDateStr]);

  const loadCompletionState = useCallback(async () => {
    try {
      const key = getCompletionKey(todayDateStr);
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        setCompletedSlots(JSON.parse(raw));
      }
    } catch {
      // ignore
    }
  }, [todayDateStr]);

  // Cleanup old keys (> 7 days)
  const cleanupOldCompletions = useCallback(async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const toRemove: string[] = [];
      for (const k of keys) {
        if (!k.startsWith(COMPLETION_KEY_PREFIX)) continue;
        const dateStr = k.replace(COMPLETION_KEY_PREFIX, '');
        const d = new Date(dateStr);
        if (!isNaN(d.getTime()) && now - d.getTime() > sevenDays) {
          toRemove.push(k);
        }
      }
      if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchProfile(true);
    fetchTrainingOverview();
    fetchNutritionOverview();
    fetchDietRecords();
    fetchDailyLog();
    loadCompletionState();
    cleanupOldCompletions();
  }, [fetchProfile, fetchTrainingOverview, fetchNutritionOverview, fetchDietRecords, fetchDailyLog, loadCompletionState, cleanupOldCompletions]);

  // AI 写回提交成功后，自动刷新首页各模块，避免“已删除/已保存但首页仍显示旧数据”的错觉。
  useEffect(() => {
    const summary = lastCommitted?.summary;
    if (!summary) return;

    if (summary.user_updated || summary.profile_updated) {
      fetchProfile(true);
    }
    if (summary.training_plan_created || summary.training_plan_deleted) {
      fetchTrainingOverview();
    }
    if (
      summary.nutrition_plan_created
      || summary.nutrition_plan_deleted
      || summary.supplement_plan_created
      || summary.supplement_plan_deleted
    ) {
      fetchNutritionOverview();
    }
    if ((summary.diet_records_created || 0) > 0 || (summary.diet_records_deleted || 0) > 0) {
      fetchDietRecords();
    }
    if (summary.daily_log_upserted || summary.daily_log_deleted) {
      fetchDailyLog();
    }
  }, [lastCommitted?.draft_id, fetchProfile, fetchTrainingOverview, fetchNutritionOverview, fetchDietRecords, fetchDailyLog]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      fetchProfile(true),
      fetchTrainingOverview(),
      fetchNutritionOverview(),
      fetchDietRecords(),
      fetchDailyLog(),
      loadCompletionState(),
    ]);
    setRefreshing(false);
  };

  const handleSaveDailyLog = useCallback(async () => {
    const w = weightInput.trim() ? parseFloat(weightInput) : undefined;
    const sh = sleepInput.trim() ? parseFloat(sleepInput) : undefined;
    if (!w && !sh) return;

    setIsSavingLog(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      const res = await api.upsertDailyLog({
        log_date: todayDateStr,
        weight: w ?? null,
        sleep_hours: sh ?? null,
      });
      if (res.success && res.data) {
        setDailyLog(res.data as DailyLog);
        setEditingLog(null);
      }
    } finally {
      setIsSavingLog(false);
    }
  }, [weightInput, sleepInput, todayDateStr]);

  // ---- Schedule logic ----

  const scheduleSlots = useMemo(
    () => buildDailySchedule(todayPlan, nutritionPlans, profile),
    [todayPlan, nutritionPlans, profile]
  );

  const scheduleLoading = planLoading || nutritionLoading;

  const completedCount = useMemo(() => {
    return scheduleSlots.filter((s) => completedSlots[s.meta.id]).length;
  }, [scheduleSlots, completedSlots]);

  const toggleSlot = useCallback((slotId: ScheduleSlotId) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(slotId)) next.delete(slotId);
      else next.add(slotId);
      return next;
    });
  }, []);

  const completeSlot = useCallback(
    async (slotId: ScheduleSlotId) => {
      const updated = { ...completedSlots, [slotId]: true };
      setCompletedSlots(updated);
      // Collapse when completing
      setExpandedSlots((prev) => {
        const next = new Set(prev);
        next.delete(slotId);
        return next;
      });
      try {
        await AsyncStorage.setItem(
          getCompletionKey(todayDateStr),
          JSON.stringify(updated)
        );
      } catch {
        // ignore
      }
    },
    [completedSlots, todayDateStr]
  );

  // Diet summary
  const dietSummary = useMemo(() => {
    if (dietRecords.length === 0) return null;
    let totalCal = 0;
    for (const r of dietRecords) {
      totalCal += r.calories || 0;
    }
    return { totalCal, count: dietRecords.length };
  }, [dietRecords]);

  const currentMealLabel = MEAL_LABELS[getCurrentMealType()];

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        style={[styles.container, { backgroundColor: themeColors.background }]}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={themeColors.primary} />}
      >
        <LinearGradient
          colors={[...Gradients.hero, themeColors.background]}
          locations={[0, 0.5, 1]}
          style={[styles.heroHeader, { paddingTop: insets.top + 16 }]}
        >
          <View style={styles.heroRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerDate}>{today}</Text>
              <Text style={styles.greeting}>你好，{user?.nickname || '练了码'}！</Text>
              <Text style={styles.subtitle}>准备好开始今天的挑战了吗？</Text>
            </View>
            <HeroAvatar nickname={user?.nickname} />
          </View>
        </LinearGradient>

        <View style={styles.mainContent}>
          {/* === 今日完成度圆环 === */}
          {!scheduleLoading && scheduleSlots.length > 0 && (
            <Animated.View entering={FadeInDown.duration(300)} style={styles.ringSection}>
              <ProgressRing
                progress={scheduleSlots.length > 0 ? completedCount / scheduleSlots.length : 0}
                size={100}
                strokeWidth={10}
                color={themeColors.primary}
                trackColor={themeColors.borderLight}
                value={`${completedCount}/${scheduleSlots.length}`}
                label="今日进度"
              />
            </Animated.View>
          )}

          {/* === 今日记录: 三横排卡片 === */}
          <SectionHeader title="今日记录" />

          {(dailyLogLoading || dietLoading) ? (
            <View style={styles.logTilesRow}>
              {[1, 2, 3].map((i) => (
                <View key={i} style={[styles.logTile, { backgroundColor: themeColors.surface }]}>
                  <Skeleton width={24} height={24} borderRadius={12} style={{ marginBottom: Spacing.sm }} />
                  <Skeleton width={40} height={20} borderRadius={4} />
                  <Skeleton width={30} height={12} borderRadius={4} style={{ marginTop: 4 }} />
                </View>
              ))}
            </View>
          ) : (
            <Animated.View entering={FadeInDown.duration(300)}>
              <View style={styles.logTilesRow}>
                {/* Diet tile */}
                <TouchableOpacity
                  style={[styles.logTile, { backgroundColor: themeColors.surface }]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    router.push('/diet/record');
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.logTileIcon, { backgroundColor: themeColors.successLight }]}>
                    <Ionicons name="restaurant-outline" size={18} color={themeColors.success} />
                  </View>
                  <Text style={[styles.logTileValue, { color: themeColors.text }]}>
                    {dietSummary ? Math.round(dietSummary.totalCal) : '--'}
                  </Text>
                  <Text style={[styles.logTileUnit, { color: themeColors.textTertiary }]}>
                    {dietSummary ? 'kcal' : currentMealLabel}
                  </Text>
                </TouchableOpacity>

                {/* Weight tile */}
                <TouchableOpacity
                  style={[
                    styles.logTile,
                    { backgroundColor: themeColors.surface },
                    editingLog === 'weight' && { borderColor: themeColors.info, borderWidth: 1.5 },
                  ]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setEditingLog(editingLog === 'weight' ? null : 'weight');
                  }}
                  onLongPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setWeightChartVisible(true);
                  }}
                  delayLongPress={400}
                  activeOpacity={0.7}
                >
                  <View style={[styles.logTileIcon, { backgroundColor: themeColors.infoLight }]}>
                    <Ionicons name="scale-outline" size={18} color={themeColors.info} />
                  </View>
                  <Text style={[styles.logTileValue, { color: themeColors.text }]}>
                    {dailyLog?.weight != null ? dailyLog.weight : '--'}
                  </Text>
                  <Text style={[styles.logTileUnit, { color: themeColors.textTertiary }]}>kg</Text>
                </TouchableOpacity>

                {/* Sleep tile */}
                <TouchableOpacity
                  style={[
                    styles.logTile,
                    { backgroundColor: themeColors.surface },
                    editingLog === 'sleep' && { borderColor: themeColors.primary, borderWidth: 1.5 },
                  ]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setEditingLog(editingLog === 'sleep' ? null : 'sleep');
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.logTileIcon, { backgroundColor: themeColors.primaryLight }]}>
                    <Ionicons name="moon-outline" size={18} color={themeColors.primary} />
                  </View>
                  <Text style={[styles.logTileValue, { color: themeColors.text }]}>
                    {dailyLog?.sleep_hours != null ? dailyLog.sleep_hours : '--'}
                  </Text>
                  <Text style={[styles.logTileUnit, { color: themeColors.textTertiary }]}>h</Text>
                </TouchableOpacity>
              </View>

              {/* Expanded edit panel for weight */}
              {editingLog === 'weight' && (
                <Animated.View entering={FadeInDown.duration(200)}>
                  <Card style={styles.logEditCard}>
                    <Text style={[styles.logEditTitle, { color: themeColors.text }]}>记录体重</Text>
                    <View style={styles.logEditRow}>
                      <TextInput
                        style={[styles.logEditInput, { color: themeColors.text, borderColor: themeColors.border, backgroundColor: themeColors.background }]}
                        value={weightInput}
                        onChangeText={setWeightInput}
                        placeholder="输入体重"
                        placeholderTextColor={themeColors.textTertiary}
                        keyboardType="decimal-pad"
                        returnKeyType="done"
                        maxLength={6}
                        autoFocus
                      />
                      <Text style={[styles.logEditUnit, { color: themeColors.textTertiary }]}>kg</Text>
                      <TouchableOpacity
                        style={[styles.logEditSave, { backgroundColor: themeColors.info, opacity: isSavingLog ? 0.5 : 1 }]}
                        onPress={handleSaveDailyLog}
                        disabled={isSavingLog}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="checkmark" size={18} color="#FFF" />
                      </TouchableOpacity>
                    </View>
                  </Card>
                </Animated.View>
              )}

              {/* Expanded edit panel for sleep */}
              {editingLog === 'sleep' && (
                <Animated.View entering={FadeInDown.duration(200)}>
                  <Card style={styles.logEditCard}>
                    <Text style={[styles.logEditTitle, { color: themeColors.text }]}>记录睡眠</Text>
                    <View style={styles.logEditRow}>
                      <TextInput
                        style={[styles.logEditInput, { color: themeColors.text, borderColor: themeColors.border, backgroundColor: themeColors.background }]}
                        value={sleepInput}
                        onChangeText={setSleepInput}
                        placeholder="睡眠时长"
                        placeholderTextColor={themeColors.textTertiary}
                        keyboardType="decimal-pad"
                        returnKeyType="done"
                        maxLength={4}
                        autoFocus
                      />
                      <Text style={[styles.logEditUnit, { color: themeColors.textTertiary }]}>小时</Text>
                      <TouchableOpacity
                        style={[styles.logEditSave, { backgroundColor: themeColors.primary, opacity: isSavingLog ? 0.5 : 1 }]}
                        onPress={handleSaveDailyLog}
                        disabled={isSavingLog}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="checkmark" size={18} color="#FFF" />
                      </TouchableOpacity>
                    </View>
                  </Card>
                </Animated.View>
              )}
            </Animated.View>
          )}

          {/* === 今日流程 === */}
          <SectionHeader
            title="今日流程"
            action={scheduleSlots.length > 0 ? `已完成 ${completedCount}/${scheduleSlots.length}` : undefined}
          />

          {/* Loading skeleton */}
          {scheduleLoading && (
            <View style={{ gap: Spacing.sm }}>
              {[1, 2, 3, 4].map((i) => (
                <View key={i} style={[styles.skeletonRow, { backgroundColor: themeColors.surface }]}>
                  <Skeleton width={38} height={38} borderRadius={19} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Skeleton width={80} height={16} borderRadius={4} />
                    <Skeleton width={160} height={12} borderRadius={4} />
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Empty state */}
          {!scheduleLoading && scheduleSlots.length === 0 && (
            <EmptyState
              icon="calendar-outline"
              title="暂无今日流程"
              subtitle="和 AI 对话生成训练或营养方案后自动出现"
              iconColor={themeColors.primary}
            />
          )}

          {/* Schedule slot rows */}
          {!scheduleLoading && scheduleSlots.length > 0 && (
            <View>
              {scheduleSlots.map((slot, index) => (
                <ScheduleSlotRow
                  key={slot.meta.id}
                  slot={slot}
                  isExpanded={expandedSlots.has(slot.meta.id)}
                  isCompleted={!!completedSlots[slot.meta.id]}
                  onToggle={() => toggleSlot(slot.meta.id)}
                  onComplete={() => completeSlot(slot.meta.id)}
                  themeColors={themeColors}
                  index={index}
                />
              ))}

              {/* Progress bar */}
              <View style={[styles.progressContainer, { backgroundColor: themeColors.surface }]}>
                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      {
                        width: `${scheduleSlots.length > 0 ? (completedCount / scheduleSlots.length) * 100 : 0}%`,
                        backgroundColor: completedCount === scheduleSlots.length ? themeColors.primary : themeColors.primary,
                      },
                    ]}
                  />
                </View>
                <Text style={[styles.progressText, { color: themeColors.textTertiary }]}>
                  已完成 {completedCount}/{scheduleSlots.length}
                  {completedCount === scheduleSlots.length && scheduleSlots.length > 0 ? ' 🎉' : ''}
                </Text>
              </View>
            </View>
          )}
          {/* === 渐变 CTA 按钮 === */}
          <View style={{ marginTop: Spacing.xl }}>
            <GradientButton
              title="开始 AI 对话"
              subtitle="获取个性化训练与营养建议"
              icon="arrow-forward"
              onPress={() => router.push('/(tabs)/ai')}
            />
          </View>
        </View>
      </ScrollView>
      <WeightChartModal visible={weightChartVisible} onClose={() => setWeightChartVisible(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 40 },

  heroHeader: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xxl,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heroAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroAvatarText: {
    fontSize: FontSize.xl,
    fontWeight: '700',
    color: '#FFF',
  },
  ringSection: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  headerDate: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.7)', marginBottom: Spacing.xs },
  greeting: { fontSize: FontSize.title, fontWeight: '700', color: '#FFF' },
  subtitle: { fontSize: FontSize.md, color: 'rgba(255,255,255,0.8)', marginTop: 4 },

  mainContent: {
    flex: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
  },

  // Daily log tiles
  logTilesRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  logTile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'transparent',
    ...Shadows.sm,
  },
  logTileIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  logTileValue: {
    fontSize: FontSize.title,
    fontWeight: '700',
  },
  logTileUnit: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },

  // Log edit panel
  logEditCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  logEditTitle: {
    fontSize: FontSize.md,
    fontWeight: '600',
    marginBottom: Spacing.md,
  },
  logEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  logEditInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  logEditUnit: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  logEditSave: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Schedule skeleton
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    gap: Spacing.md,
    borderRadius: Radius.lg,
  },

  // Progress bar
  progressContainer: {
    borderRadius: Radius.lg,
    padding: Spacing.md,
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
    ...Shadows.sm,
  },
  progressBarTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  progressText: {
    fontSize: FontSize.xs,
    fontWeight: '500',
  },
});
