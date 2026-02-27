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
import { Spacing, Radius, FontSize, SEVERITY_LABELS, HitSlop } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { Condition, Severity } from '../../../shared/types';

export default function ConditionsScreen() {
  const Colors = useThemeColor();
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchConditions = useCallback(async () => {
    try {
      const res = await api.getConditions();
      if (res.success && res.data) setConditions(res.data as Condition[]);
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { fetchConditions(); }, [fetchConditions]);

  const handleRefresh = () => { setRefreshing(true); fetchConditions(); };

  const handleSubmit = async () => {
    if (!name.trim()) {
      Toast.show({ type: 'error', text1: '提示', text2: '请填写伤病名称' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.createCondition({ name: name.trim(), description: description.trim() || undefined, severity: (severity as Severity) || undefined });
      if (res.success) {
        setShowForm(false); setName(''); setDescription(''); setSeverity(null);
        fetchConditions();
      } else {
        Toast.show({ type: 'error', text1: '添加失败', text2: res.error || '未知错误' });
      }
    } catch {
      Toast.show({ type: 'error', text1: '添加失败', text2: '网络错误' });
    } finally { setSubmitting(false); }
  };

  const handleToggleStatus = (item: Condition) => {
    const newStatus = item.status === 'active' ? 'recovered' : 'active';
    const label = newStatus === 'recovered' ? '标记为已恢复' : '标记为进行中';
    Alert.alert(label, `确定要将「${item.name}」${label}吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '确定', onPress: async () => { await api.updateCondition(item.id, { status: newStatus }); fetchConditions(); } },
    ]);
  };

  const handleDelete = (item: Condition) => {
    Alert.alert('确认删除', `确定要删除「${item.name}」吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => { await api.deleteCondition(item.id); fetchConditions(); } },
    ]);
  };

  const severityColor = (s: string | null) => {
    if (s === 'severe') return Colors.danger;
    if (s === 'moderate') return Colors.warning;
    return Colors.success;
  };

  const VALID_SEVERITIES = ['mild', 'moderate', 'severe'];

  const handleImageResult = useCallback(async (rawText: string) => {
    const parsed = parseAIJson<{ conditions: Array<{ name: string; description?: string; severity?: string }> }>(rawText);
    if (!parsed?.conditions?.length) {
      Toast.show({ type: 'error', text1: '识别失败', text2: 'AI 未识别到伤病信息' });
      return;
    }

    const results = await Promise.allSettled(
      parsed.conditions.map((c) =>
        api.createCondition({
          name: String(c.name).slice(0, 100),
          description: c.description ? String(c.description).slice(0, 500) : undefined,
          severity: (c.severity && VALID_SEVERITIES.includes(c.severity) ? c.severity : undefined) as Severity | undefined,
        })
      )
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    Toast.show({ type: 'success', text1: `已添加 ${succeeded} 条伤病记录` });
    fetchConditions();
  }, [fetchConditions]);

  const { pickAndAnalyze, analyzing } = useImageAnalysis({
    buildPrompt: useCallback(() =>
      `分析图片，提取医疗诊断/病历中的伤病信息。严重程度只能是 mild(轻度)/moderate(中度)/severe(重度)。\n返回 JSON：\n{"conditions":[{"name":"伤病名称","description":"描述","severity":"mild"}]}\n请严格只返回 JSON，不要 Markdown 解释。`, []),
    onResult: handleImageResult,
  });

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: '伤病记录' }} />
        <View style={styles.content}>
          {[1, 2].map((i) => (
            <View key={i} style={[{ backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg }]}>
              <Skeleton width={120} height={20} borderRadius={4} style={{ marginBottom: Spacing.sm }} />
              <Skeleton width="80%" height={16} borderRadius={4} style={{ marginBottom: 6 }} />
              <Skeleton width="60%" height={16} borderRadius={4} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  const active = conditions.filter((c) => c.status === 'active');
  const recovered = conditions.filter((c) => c.status === 'recovered');

  return (
    <View style={[styles.container, { backgroundColor: Colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: '伤病记录' }} />
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.info} />}>
        {showForm && (
          <Card style={[styles.formCard, { borderColor: Colors.info + '30' }]}>
            <Text style={[styles.formTitle, { color: Colors.text }]}>记录伤病</Text>
            <FormField label="伤病名称">
              <ThemedInput value={name} onChangeText={setName} placeholder="如：腰间盘突出" />
            </FormField>
            <FormField label="详细描述" hint="位置、症状、持续时间等">
              <ThemedInput value={description} onChangeText={setDescription} placeholder="L4-L5 轻度膨出，久坐后腰痛明显..." multiline numberOfLines={4} style={styles.textArea} />
            </FormField>
            <FormField label="严重程度">
              <OptionPicker options={Object.entries(SEVERITY_LABELS).map(([v, l]) => ({ value: v, label: l }))} selected={severity} onSelect={setSeverity} color={Colors.info} />
            </FormField>
            <View style={styles.formActions}>
              <Button title="取消" onPress={() => setShowForm(false)} variant="ghost" size="sm" />
              <Button title="添加" onPress={handleSubmit} loading={submitting} size="sm" color={Colors.info} />
            </View>
          </Card>
        )}
        {!showForm && (
          <View style={styles.buttonRow}>
            <View style={{ flex: 1 }}>
              <Button title="记录伤病" onPress={() => setShowForm(true)} icon="add-circle-outline" variant="outline" color={Colors.info} />
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
            <Text style={[styles.analyzingText, { color: Colors.textSecondary }]}>正在分析病历/诊断报告...</Text>
          </Card>
        )}
        {conditions.length === 0 && !showForm ? (
          <EmptyState icon="bandage-outline" title="暂无伤病记录" subtitle="如果有伤病或外科问题，记录在这里让 AI 康复师帮你制定方案" iconColor={Colors.info} />
        ) : (
          <>
            {active.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionLabel, { color: Colors.textTertiary }]}>进行中 ({active.length})</Text>
                {active.map((item, index) => (
                  <Animated.View key={item.id} entering={FadeInDown.duration(300).delay(index * 50)}>
                    <Card style={styles.conditionCard}>
                      <View style={styles.conditionHeader}>
                        <Text style={[styles.conditionName, { color: Colors.text }]}>{item.name}</Text>
                        {item.severity && <Badge label={SEVERITY_LABELS[item.severity] || item.severity} color={severityColor(item.severity)} />}
                      </View>
                      {item.description && <Text style={[styles.conditionDesc, { color: Colors.textSecondary }]}>{item.description}</Text>}
                      <View style={[styles.conditionActions, { borderTopColor: Colors.borderLight }]}>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => handleToggleStatus(item)} hitSlop={HitSlop.sm}>
                          <Ionicons name="checkmark-circle-outline" size={18} color={Colors.success} />
                          <Text style={[styles.actionText, { color: Colors.success }]}>已恢复</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => handleDelete(item)} hitSlop={HitSlop.sm}>
                          <Ionicons name="trash-outline" size={18} color={Colors.textTertiary} />
                          <Text style={[styles.actionText, { color: Colors.textTertiary }]}>删除</Text>
                        </TouchableOpacity>
                      </View>
                    </Card>
                  </Animated.View>
                ))}
              </View>
            )}
            {recovered.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionLabel, { color: Colors.textTertiary }]}>已恢复 ({recovered.length})</Text>
                {recovered.map((item) => (
                  <Card key={item.id} style={[styles.conditionCard, { opacity: 0.6 }]}>
                    <View style={styles.conditionHeader}>
                      <Text style={[styles.conditionName, { color: Colors.text }]}>{item.name}</Text>
                      <Badge label="已恢复" color={Colors.success} />
                    </View>
                    <View style={[styles.conditionActions, { borderTopColor: Colors.borderLight }]}>
                      <TouchableOpacity style={styles.actionBtn} onPress={() => handleToggleStatus(item)} hitSlop={HitSlop.sm}>
                        <Ionicons name="refresh-outline" size={18} color={Colors.warning} />
                        <Text style={[styles.actionText, { color: Colors.warning }]}>复发</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.actionBtn} onPress={() => handleDelete(item)} hitSlop={HitSlop.sm}>
                        <Ionicons name="trash-outline" size={18} color={Colors.textTertiary} />
                        <Text style={[styles.actionText, { color: Colors.textTertiary }]}>删除</Text>
                      </TouchableOpacity>
                    </View>
                  </Card>
                ))}
              </View>
            )}
          </>
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
  textArea: { minHeight: 100, textAlignVertical: 'top' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  section: { gap: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '500' },
  conditionCard: { padding: Spacing.lg },
  conditionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs },
  conditionName: { fontSize: FontSize.lg, fontWeight: '500', flex: 1, marginRight: Spacing.sm },
  conditionDesc: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.sm },
  conditionActions: { flexDirection: 'row', gap: Spacing.xl, marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  actionText: { fontSize: FontSize.sm, fontWeight: '500' },
});
