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
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../stores/auth';
import { useProfileStore } from '../../stores/profile';
import { SectionHeader, Card, Badge, Skeleton } from '../../components/ui';
import { Spacing, Radius, FontSize, Shadows } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { api } from '../../services/api';
import { streamSingleRoleAgent } from '../../services/agent-stream';
import { parseContent } from '../../utils';
import { WeightChartModal } from '../../components/WeightChartModal';
import type { TrainingPlan, DietRecord, MealType, DailyLog } from '../../../shared/types';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

const PLAN_PROMPT = `帮我安排今天的训练计划。

要求：
1. 禁止任何开场白、问候语、总结语、课后建议、鼓励话术
2. 直接输出计划内容，第一行必须是 ## 开头
3. 严格按以下格式，不要多余文字：

## 热身激活
### 动作名称
- 组数×次数或时长

## 正式训练
### 动作名称
- 组数×次数、负重建议

## 静态放松
### 动作名称
- 时长`;

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

// --- Plan parsing ---
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

  // Strip greeting / sign-off lines that appear before or after the plan body
  const firstSection = raw.indexOf('## ');
  const cleaned = firstSection >= 0 ? raw.slice(firstSection) : raw;
  // Remove trailing non-section text (课后建议, 加油 etc.)
  const lastSectionEnd = cleaned.lastIndexOf('\n## ');
  const body = lastSectionEnd >= 0 ? cleaned : cleaned;
  // Just trim anything after the last exercise block ends
  const trimmed = body.replace(/\n(?!##|###|- )(?!$)[^#\n-].*$/gm, (match, offset) => {
    // Keep lines that are part of exercise details (indented or bullet)
    const line = match.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) return match;
    // If it's after the last section, strip it
    const after = body.slice(offset);
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

export default function HomeScreen() {
  const router = useRouter();
  const themeColors = useThemeColor();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const { fetchProfile } = useProfileStore();
  const [refreshing, setRefreshing] = useState(false);

  // Plan states
  const [todayPlan, setTodayPlan] = useState<TrainingPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const streamContentRef = useRef('');
  const scrollRef = useRef<ScrollView>(null);

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

  // Collapsible exercise state: stores "sectionIdx-exerciseIdx" keys
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

  const today = useMemo(() => {
    const d = new Date();
    return `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}`;
  }, []);

  const todayDateStr = useMemo(() => getTodayDate(), []);

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

  useEffect(() => {
    fetchProfile(true);
    fetchTrainingOverview();
    fetchDietRecords();
    fetchDailyLog();
  }, [fetchProfile, fetchTrainingOverview, fetchDietRecords, fetchDailyLog]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchProfile(true), fetchTrainingOverview(), fetchDietRecords(), fetchDailyLog()]);
    setRefreshing(false);
  };

  const handleGenerate = useCallback(() => {
    if (isGenerating) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsGenerating(true);
    setStreamContent('');
    streamContentRef.current = '';
    setExpanded(new Set());

    void streamSingleRoleAgent({
      role: 'trainer',
      message: PLAN_PROMPT,
      onChunk: (chunk) => {
        streamContentRef.current += chunk;
        setStreamContent(streamContentRef.current);
      },
      onDone: async () => {
        const content = streamContentRef.current;
        try {
          const res = await api.createTrainingPlan({
            plan_date: todayDateStr,
            content,
          });
          if (res.success) {
            await fetchTrainingOverview();
          }
        } catch {
          // keep showing generated content even if save fails
        }
        setIsGenerating(false);
      },
      onError: () => {
        setIsGenerating(false);
      },
    });
  }, [isGenerating, todayDateStr, fetchTrainingOverview]);

  const handleComplete = useCallback(() => {
    if (!todayPlan || todayPlan.completed) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    api.completeTrainingPlan(todayPlan.id).then(() => {
      setTodayPlan((prev) => (prev ? { ...prev, completed: 1 } : null));
    });
  }, [todayPlan]);

  const handleRegenerate = useCallback(() => {
    setTodayPlan(null);
    setStreamContent('');
    handleGenerate();
  }, [handleGenerate]);

  // Diet summary
  const dietSummary = useMemo(() => {
    if (dietRecords.length === 0) return null;
    let totalCal = 0;
    for (const r of dietRecords) {
      totalCal += r.calories || 0;
    }
    return { totalCal, count: dietRecords.length };
  }, [dietRecords]);

  // Parse plan into structured sections (for completed plans)
  const displayContent = todayPlan ? parseContent(todayPlan.content) : streamContent;
  const hasPlan = !!todayPlan || streamContent.length > 0;
  const sections = useMemo(
    () => (todayPlan ? parsePlanSections(todayPlan.content) : null),
    [todayPlan]
  );

  const sectionColors = useMemo(
    () => [themeColors.warning, themeColors.primary, themeColors.success],
    [themeColors]
  );

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
          colors={[themeColors.primary, themeColors.primary + 'CC', themeColors.background]}
          locations={[0, 0.6, 1]}
          style={[styles.heroHeader, { paddingTop: insets.top + 16 }]}
        >
          <Text style={styles.headerDate}>{today}</Text>
          <Text style={styles.greeting}>你好，{user?.nickname || '练了码'}！</Text>
          <Text style={styles.subtitle}>准备好开始今天的挑战了吗？</Text>
        </LinearGradient>

        <View style={styles.mainContent}>
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

          <SectionHeader title="今日训练" />

          {/* Loading skeleton */}
          {planLoading && !hasPlan && !isGenerating && (
            <Card style={styles.planCard}>
              <Skeleton width={120} height={20} borderRadius={4} style={{ marginBottom: Spacing.md }} />
              <Skeleton width="100%" height={16} borderRadius={4} style={{ marginBottom: 6 }} />
              <Skeleton width="80%" height={16} borderRadius={4} style={{ marginBottom: 6 }} />
              <Skeleton width="60%" height={16} borderRadius={4} />
            </Card>
          )}

          {/* No plan — generate button */}
          {!planLoading && !hasPlan && !isGenerating && (
            <Animated.View entering={FadeInDown.duration(400).delay(100)}>
              <TouchableOpacity
                style={styles.mainActionContainer}
                activeOpacity={0.8}
                onPress={handleGenerate}
                accessibilityLabel="生成今日训练计划"
                accessibilityRole="button"
              >
                <LinearGradient
                  colors={[themeColors.primary, themeColors.primary + 'DD']}
                  style={styles.mainActionCard}
                >
                  <View style={[styles.actionIconBox, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
                    <Ionicons name="flame" size={32} color="#FFF" />
                  </View>
                  <Text style={[styles.actionTitle, { color: '#FFF' }]}>生成今日训练计划</Text>
                  <Text style={[styles.actionDesc, { color: 'rgba(255,255,255,0.85)' }]}>AI 将根据你的身体数据实时生成专属方案</Text>
                  <View style={[styles.actionButton, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
                    <Text style={styles.actionBtnText}>立即生成</Text>
                    <Ionicons name="arrow-forward" size={16} color="#FFF" />
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>
          )}

          {/* Streaming — show raw text with typing dots */}
          {isGenerating && (
            <Animated.View entering={FadeInDown.duration(300)}>
              <Card style={styles.planCard}>
                <View style={styles.planHeader}>
                  <View style={styles.planDateRow}>
                    <Ionicons name="calendar-outline" size={14} color={themeColors.textTertiary} />
                    <Text style={[styles.planDateText, { color: themeColors.textTertiary }]}>{todayDateStr}</Text>
                  </View>
                  <Badge label="生成中..." color={themeColors.primary} />
                </View>
                <Text style={[styles.streamText, { color: themeColors.text }]}>{streamContent}</Text>
                <View style={styles.typingDots}>
                  <View style={[styles.dot, { backgroundColor: themeColors.primary }]} />
                  <View style={[styles.dot, { backgroundColor: themeColors.primary, opacity: 0.6 }]} />
                  <View style={[styles.dot, { backgroundColor: themeColors.primary, opacity: 0.3 }]} />
                </View>
              </Card>
            </Animated.View>
          )}

          {/* Plan loaded — structured collapsible view */}
          {todayPlan && !isGenerating && (
            <Animated.View entering={FadeInDown.duration(300)}>
              <Card style={styles.planCard}>
                <View style={styles.planHeader}>
                  <View style={styles.planDateRow}>
                    <Ionicons name="calendar-outline" size={14} color={themeColors.textTertiary} />
                    <Text style={[styles.planDateText, { color: themeColors.textTertiary }]}>{todayDateStr}</Text>
                  </View>
                </View>

                {sections ? (
                  // Structured view: section labels + tappable exercises
                  sections.map((section, si) => {
                    const color = sectionColors[si % sectionColors.length];
                    return (
                      <View key={si} style={si > 0 ? styles.section : styles.sectionFirst}>
                        <View style={styles.sectionLabel}>
                          <View style={[styles.sectionDot, { backgroundColor: color }]} />
                          <Text style={[styles.sectionTitle, { color: themeColors.textSecondary }]}>{section.title}</Text>
                        </View>
                        {section.exercises.map((ex, ei) => {
                          const key = `${si}-${ei}`;
                          const isOpen = expanded.has(key);
                          return (
                            <TouchableOpacity
                              key={key}
                              style={styles.exerciseItem}
                              onPress={() => toggleExercise(key)}
                              activeOpacity={0.7}
                            >
                              <View style={styles.exerciseRow}>
                                <Text style={[styles.exerciseName, { color: themeColors.text }]}>{ex.name}</Text>
                                <Ionicons
                                  name={isOpen ? 'chevron-up' : 'chevron-down'}
                                  size={14}
                                  color={themeColors.textTertiary}
                                />
                              </View>
                              {isOpen && (
                                <Text style={[styles.exerciseDetails, { color: themeColors.textSecondary }]}>
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
                  // Fallback: plain text for old-format plans
                  <Text style={[styles.fallbackText, { color: themeColors.text }]}>{displayContent}</Text>
                )}

                {/* Actions */}
                <View style={[styles.planActions, { borderTopColor: themeColors.borderLight }]}>
                  <TouchableOpacity style={styles.planActionBtn} onPress={handleRegenerate} activeOpacity={0.6}>
                    <Ionicons name="refresh-outline" size={16} color={themeColors.textTertiary} />
                    <Text style={[styles.planActionText, { color: themeColors.textTertiary }]}>重新生成</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.planActionBtn}
                    onPress={handleComplete}
                    disabled={!!todayPlan.completed}
                    activeOpacity={0.6}
                  >
                    <Ionicons
                      name={todayPlan.completed ? 'checkmark-circle' : 'checkmark-circle-outline'}
                      size={16}
                      color={todayPlan.completed ? themeColors.success : themeColors.primary}
                    />
                    <Text style={[styles.planActionText, { color: todayPlan.completed ? themeColors.success : themeColors.primary }]}>
                      {todayPlan.completed ? '已完成' : '标记完成'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </Card>
            </Animated.View>
          )}
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
    fontSize: FontSize.xl,
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

  // Generate button
  mainActionContainer: {
    marginBottom: Spacing.lg,
    borderRadius: Radius.xl,
    ...Shadows.lg,
  },
  mainActionCard: {
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    alignItems: 'center',
  },
  actionIconBox: { width: 64, height: 64, borderRadius: Radius.full, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.md },
  actionTitle: { fontSize: FontSize.xl, fontWeight: '700', marginBottom: Spacing.sm },
  actionDesc: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20, marginBottom: Spacing.xl, paddingHorizontal: Spacing.md },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: 14,
    borderRadius: Radius.full,
    gap: Spacing.sm,
  },
  actionBtnText: { color: '#FFF', fontSize: FontSize.md, fontWeight: '600' },

  // Plan card
  planCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  planHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  planDateRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  planDateText: { fontSize: FontSize.sm },

  // Streaming
  streamText: { fontSize: FontSize.sm, lineHeight: 20 },
  typingDots: { flexDirection: 'row', gap: Spacing.xs, marginTop: Spacing.sm },
  dot: { width: 6, height: 6, borderRadius: 3 },

  // Structured sections
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

  // Actions
  planActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.xl,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
  },
  planActionBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  planActionText: { fontSize: FontSize.sm, fontWeight: '500' },
});
