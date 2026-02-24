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
import { Card, Button, Badge, EmptyState, Skeleton, FormField, ThemedInput } from '../../components/ui';
import { Spacing, Radius, FontSize, HitSlop } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { TrainingGoal } from '../../../shared/types';

export default function TrainingGoalScreen() {
  const Colors = useThemeColor();
  const [goals, setGoals] = useState<TrainingGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchGoals = useCallback(async () => {
    try {
      const res = await api.getTrainingGoals();
      if (res.success && res.data) setGoals(res.data as TrainingGoal[]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  const handleRefresh = () => { setRefreshing(true); fetchGoals(); };

  const handleSubmit = async () => {
    if (!name.trim()) {
      Toast.show({ type: 'error', text1: '提示', text2: '请填写目标名称' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.createTrainingGoal({ name: name.trim(), description: description.trim() || undefined });
      if (res.success) {
        setShowForm(false); setName(''); setDescription('');
        fetchGoals();
      } else {
        Toast.show({ type: 'error', text1: '添加失败', text2: res.error || '未知错误' });
      }
    } catch {
      Toast.show({ type: 'error', text1: '添加失败', text2: '网络错误' });
    } finally { setSubmitting(false); }
  };

  const handleToggleStatus = (item: TrainingGoal) => {
    const newStatus = item.status === 'active' ? 'completed' : 'active';
    const label = newStatus === 'completed' ? '标记为已完成' : '重新激活';
    Alert.alert(label, `确定要将「${item.name}」${label}吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '确定', onPress: async () => { await api.updateTrainingGoal(item.id, { status: newStatus }); fetchGoals(); } },
    ]);
  };

  const handleDelete = (item: TrainingGoal) => {
    Alert.alert('确认删除', `确定要删除「${item.name}」吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => { await api.deleteTrainingGoal(item.id); fetchGoals(); } },
    ]);
  };

  const handleImageResult = useCallback(async (rawText: string) => {
    const parsed = parseAIJson<{ goals: Array<{ name: string; description?: string }> }>(rawText);
    if (!parsed?.goals?.length) {
      Toast.show({ type: 'error', text1: '识别失败', text2: 'AI 未识别到训练目标' });
      return;
    }

    const results = await Promise.allSettled(
      parsed.goals.map((g) =>
        api.createTrainingGoal({ name: String(g.name).slice(0, 100), description: g.description ? String(g.description).slice(0, 500) : undefined })
      )
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    Toast.show({ type: 'success', text1: `已添加 ${succeeded} 个训练目标` });
    fetchGoals();
  }, [fetchGoals]);

  const { pickAndAnalyze, analyzing } = useImageAnalysis({
    role: 'trainer',
    buildPrompt: useCallback(() =>
      '分析图片，提取训练目标。返回 JSON：\n{"goals":[{"name":"目标名称","description":"详细描述"}]}\n请严格只返回 JSON，不要 Markdown 解释。', []),
    onResult: handleImageResult,
  });

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: '训练目标' }} />
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

  const active = goals.filter((g) => g.status === 'active');
  const completed = goals.filter((g) => g.status === 'completed');

  return (
    <View style={[styles.container, { backgroundColor: Colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: '训练目标' }} />
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.warning} />}>
        {showForm && (
          <Card style={[styles.formCard, { borderColor: Colors.warning + '30' }]}>
            <Text style={[styles.formTitle, { color: Colors.text }]}>添加目标</Text>
            <FormField label="目标名称">
              <ThemedInput value={name} onChangeText={setName} placeholder="如：3个月内体重降到105kg" />
            </FormField>
            <FormField label="详细描述" hint="可选，补充说明">
              <ThemedInput value={description} onChangeText={setDescription} placeholder="包含具体计划、时间节点..." multiline numberOfLines={3} style={styles.textArea} />
            </FormField>
            <View style={styles.formActions}>
              <Button title="取消" onPress={() => setShowForm(false)} variant="ghost" size="sm" />
              <Button title="添加" onPress={handleSubmit} loading={submitting} size="sm" color={Colors.warning} />
            </View>
          </Card>
        )}
        {!showForm && (
          <View style={styles.buttonRow}>
            <View style={{ flex: 1 }}>
              <Button title="添加目标" onPress={() => setShowForm(true)} icon="add-circle-outline" variant="outline" color={Colors.warning} />
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
            <Text style={[styles.analyzingText, { color: Colors.textSecondary }]}>正在分析图片中的训练目标...</Text>
          </Card>
        )}
        {goals.length === 0 && !showForm ? (
          <EmptyState icon="flag-outline" title="暂无训练目标" subtitle="设置你的训练目标，让 AI 教练帮你制定计划" iconColor={Colors.warning} />
        ) : (
          <>
            {active.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionLabel, { color: Colors.textTertiary }]}>进行中 ({active.length})</Text>
                {active.map((item, index) => (
                  <Animated.View key={item.id} entering={FadeInDown.duration(300).delay(index * 50)}>
                    <Card style={styles.goalCard}>
                      <View style={styles.goalHeader}>
                        <Text style={[styles.goalName, { color: Colors.text }]}>{item.name}</Text>
                        <Badge label="进行中" color={Colors.warning} />
                      </View>
                      {item.description && <Text style={[styles.goalDesc, { color: Colors.textSecondary }]}>{item.description}</Text>}
                      <View style={[styles.goalActions, { borderTopColor: Colors.borderLight }]}>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => handleToggleStatus(item)} hitSlop={HitSlop.sm}>
                          <Ionicons name="checkmark-circle-outline" size={18} color={Colors.success} />
                          <Text style={[styles.actionText, { color: Colors.success }]}>已完成</Text>
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
            {completed.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionLabel, { color: Colors.textTertiary }]}>已完成 ({completed.length})</Text>
                {completed.map((item) => (
                  <Card key={item.id} style={[styles.goalCard, { opacity: 0.6 }]}>
                    <View style={styles.goalHeader}>
                      <Text style={[styles.goalName, { color: Colors.text }]}>{item.name}</Text>
                      <Badge label="已完成" color={Colors.success} />
                    </View>
                    <View style={[styles.goalActions, { borderTopColor: Colors.borderLight }]}>
                      <TouchableOpacity style={styles.actionBtn} onPress={() => handleToggleStatus(item)} hitSlop={HitSlop.sm}>
                        <Ionicons name="refresh-outline" size={18} color={Colors.warning} />
                        <Text style={[styles.actionText, { color: Colors.warning }]}>重新激活</Text>
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
  formCard: { borderWidth: 1 },
  formTitle: { fontSize: FontSize.lg, fontWeight: '600', marginBottom: Spacing.lg },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  analyzingCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.lg },
  analyzingText: { fontSize: FontSize.sm },
  section: { gap: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '500' },
  goalCard: { padding: Spacing.lg },
  goalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs },
  goalName: { fontSize: FontSize.lg, fontWeight: '500', flex: 1, marginRight: Spacing.sm },
  goalDesc: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.sm },
  goalActions: { flexDirection: 'row', gap: Spacing.xl, marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  actionText: { fontSize: FontSize.sm, fontWeight: '500' },
});
