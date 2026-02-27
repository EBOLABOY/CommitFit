import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Alert,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { api } from '../../services/api';
import { useImageAnalysis, parseAIJson } from '../../hooks/useImageAnalysis';
import { Card, Button, Badge, EmptyState, Skeleton, FormField, OptionPicker, ThemedInput } from '../../components/ui';
import { Spacing, Radius, FontSize, METRIC_TYPE_LABELS, HitSlop } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { HealthMetric, MetricType } from '@shared/types';

export default function HealthMetricsScreen() {
  const Colors = useThemeColor();
  const [metrics, setMetrics] = useState<HealthMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [metricType, setMetricType] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [recordedAt, setRecordedAt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await api.getHealthMetrics();
      if (res.success && res.data) setMetrics(res.data as HealthMetric[]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  const handleRefresh = () => { setRefreshing(true); fetchMetrics(); };

  const handleSubmit = async () => {
    if (!metricType || !value.trim()) {
      Toast.show({ type: 'error', text1: '提示', text2: '请选择指标类型并填写数值' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.createHealthMetric({ metric_type: metricType as MetricType, value: value.trim(), unit: unit.trim() || undefined, recorded_at: recordedAt.trim() || undefined });
      if (res.success) {
        Toast.show({ type: 'success', text1: '添加成功' });
        setShowForm(false); setMetricType(null); setValue(''); setUnit(''); setRecordedAt('');
        fetchMetrics();
      } else {
        Toast.show({ type: 'error', text1: '添加失败', text2: res.error || '未知错误' });
      }
    } catch {
      Toast.show({ type: 'error', text1: '添加失败', text2: '网络错误' });
    } finally { setSubmitting(false); }
  };

  const handleDelete = (id: string) => {
    Alert.alert('确认删除', '确定要删除这条记录吗？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => { await api.deleteHealthMetric(id); fetchMetrics(); } },
    ]);
  };

  const VALID_METRIC_TYPES = Object.keys(METRIC_TYPE_LABELS);

  const handleImageResult = useCallback(async (rawText: string) => {
    const parsed = parseAIJson<{ metrics: Array<{ metric_type: string; value: string; unit?: string; recorded_at?: string }> }>(rawText);
    if (!parsed?.metrics?.length) {
      Toast.show({ type: 'error', text1: '识别失败', text2: 'AI 未识别到指标数据' });
      return;
    }

    const results = await Promise.allSettled(
      parsed.metrics
        .filter((m) => VALID_METRIC_TYPES.includes(m.metric_type))
        .map((m) =>
          api.createHealthMetric({
            metric_type: m.metric_type as MetricType,
            value: String(m.value),
            unit: m.unit || undefined,
            recorded_at: m.recorded_at || undefined,
          })
        )
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    Toast.show({ type: 'success', text1: `已添加 ${succeeded} 条指标` });
    fetchMetrics();
  }, [fetchMetrics]);

  const { pickAndAnalyze, analyzing } = useImageAnalysis({
    buildPrompt: useCallback(() =>
      `分析图片，提取化验单/体检报告中的健康指标。可识别的指标类型：${Object.entries(METRIC_TYPE_LABELS).map(([k, v]) => `${k}(${v})`).join('、')}。\n返回 JSON：\n{"metrics":[{"metric_type":"blood_pressure","value":"120/80","unit":"mmHg","recorded_at":"2024-01-15"}]}\n请严格只返回 JSON，不要 Markdown 解释。`, []),
    onResult: handleImageResult,
  });

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: '理化指标' }} />
        <View style={styles.content}>
          {[1, 2, 3].map((i) => (
            <View key={i} style={[styles.metricCard, { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg }]}>
              <Skeleton width={60} height={20} borderRadius={4} style={{ marginBottom: Spacing.sm }} />
              <Skeleton width={100} height={24} borderRadius={4} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: '理化指标' }} />
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.primary} />}>
        {showForm && (
          <Card style={[styles.formCard, { borderColor: Colors.danger + '30' }]}>
            <Text style={[styles.formTitle, { color: Colors.text }]}>添加指标</Text>
            <FormField label="指标类型">
              <OptionPicker options={Object.entries(METRIC_TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))} selected={metricType} onSelect={setMetricType} color={Colors.danger} />
            </FormField>
            <View style={styles.row}>
              <View style={{ flex: 2 }}>
                <FormField label="数值">
                  <ThemedInput value={value} onChangeText={setValue} placeholder="如: 550" keyboardType="decimal-pad" />
                </FormField>
              </View>
              <View style={{ flex: 1 }}>
                <FormField label="单位">
                  <ThemedInput value={unit} onChangeText={setUnit} placeholder="ng/dL" />
                </FormField>
              </View>
            </View>
            <FormField label="检测日期" hint="格式：2024-01-15">
              <ThemedInput value={recordedAt} onChangeText={setRecordedAt} placeholder="2024-01-15" />
            </FormField>
            <View style={styles.formActions}>
              <Button title="取消" onPress={() => setShowForm(false)} variant="ghost" size="sm" />
              <Button title="添加" onPress={handleSubmit} loading={submitting} size="sm" color={Colors.danger} />
            </View>
          </Card>
        )}
        {!showForm && (
          <View style={styles.buttonRow}>
            <View style={{ flex: 1 }}>
              <Button title="添加指标" onPress={() => setShowForm(true)} icon="add-circle-outline" variant="outline" color={Colors.danger} />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title={analyzing ? 'AI 识别中...' : 'AI 图片识别'}
                onPress={pickAndAnalyze}
                icon="camera-outline"
                variant="outline"
                color={Colors.primary}
                loading={analyzing}
                disabled={analyzing}
              />
            </View>
          </View>
        )}
        {analyzing && (
          <Card style={styles.analyzingCard}>
            <ActivityIndicator color={Colors.primary} size="small" />
            <Text style={[styles.analyzingText, { color: Colors.textSecondary }]}>正在分析化验单/体检报告...</Text>
          </Card>
        )}
        {metrics.length === 0 && !showForm ? (
          <EmptyState icon="analytics-outline" title="暂无理化指标" subtitle="添加你的血液检查、血压等健康数据，让 AI 医生更好地评估" iconColor={Colors.danger} />
        ) : (
          <View style={styles.metricsList}>
            {metrics.map((m, index) => (
              <Animated.View key={m.id} entering={FadeInDown.duration(300).delay(index * 50)}>
                <Card style={styles.metricCard}>
                  <View style={styles.metricHeader}>
                    <Badge label={METRIC_TYPE_LABELS[m.metric_type] || m.metric_type} color={Colors.danger} />
                    {m.recorded_at && <Text style={[styles.metricDate, { color: Colors.textTertiary }]}>{m.recorded_at}</Text>}
                  </View>
                  <View style={styles.metricBody}>
                    <Text style={[styles.metricValue, { color: Colors.text }]}>
                      {m.value}{m.unit && <Text style={[styles.metricUnit, { color: Colors.textTertiary }]}> {m.unit}</Text>}
                    </Text>
                    <TouchableOpacity onPress={() => handleDelete(m.id)} hitSlop={HitSlop.md}>
                      <Ionicons name="trash-outline" size={18} color={Colors.textTertiary} />
                    </TouchableOpacity>
                  </View>
                </Card>
              </Animated.View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.lg },
  buttonRow: { flexDirection: 'row', gap: Spacing.md },
  analyzingCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.lg },
  analyzingText: { fontSize: FontSize.sm },
  formCard: { borderWidth: 1 },
  formTitle: { fontSize: FontSize.lg, fontWeight: '600', marginBottom: Spacing.lg },
  row: { flexDirection: 'row', gap: Spacing.md },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  metricsList: { gap: Spacing.md },
  metricCard: { padding: Spacing.lg },
  metricHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  metricDate: { fontSize: FontSize.xs },
  metricBody: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metricValue: { fontSize: FontSize.xl, fontWeight: '700' },
  metricUnit: { fontSize: FontSize.sm, fontWeight: '400' },
});
