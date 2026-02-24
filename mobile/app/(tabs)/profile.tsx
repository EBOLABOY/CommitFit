import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api, clearToken } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ProfileData } from '../../stores/profile';
import { Card, ListItem, Badge, SectionHeader } from '../../components/ui';
import { Spacing, Radius, FontSize, GENDER_LABELS, EXPERIENCE_LABELS } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';

export default function ProfileScreen() {
  const Colors = useThemeColor();
  const { user, logout } = useAuthStore();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [conditionCount, setConditionCount] = useState(0);
  const [goalCount, setGoalCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [profileRes, condRes, goalRes] = await Promise.all([
        api.getProfile(),
        api.getConditions('active'),
        api.getTrainingGoals('active'),
      ]);
      if (profileRes.success && profileRes.data) setProfile(profileRes.data as ProfileData);
      if (condRes.success && condRes.data) setConditionCount((condRes.data as unknown[]).length);
      if (goalRes.success && goalRes.data) setGoalCount((goalRes.data as unknown[]).length);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const handleLogout = () => {
    Alert.alert('退出登录', '确定要退出登录吗？', [
      { text: '取消', style: 'cancel' },
      { text: '确定', style: 'destructive', onPress: logout },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      '注销账号',
      '此操作不可撤销！你的所有数据（个人资料、聊天记录、训练计划等）都将被永久删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '永久删除',
          style: 'destructive',
          onPress: () => {
            Alert.alert('再次确认', '真的要永久删除你的账号吗？', [
              { text: '取消', style: 'cancel' },
              {
                text: '确认删除',
                style: 'destructive',
                onPress: async () => {
                  await api.deleteAccount();
                  await clearToken();
                  logout();
                },
              },
            ]);
          },
        },
      ]
    );
  };

  const bmi = profile?.height && profile?.weight
    ? (profile.weight / ((profile.height / 100) ** 2)).toFixed(1)
    : null;

  const profileMeta = useMemo(() => {
    const parts: string[] = [];
    if (profile?.age) parts.push(`${profile.age}岁`);
    if (profile?.gender) parts.push(GENDER_LABELS[profile.gender] || profile.gender);
    if (profile?.experience_level) {
      parts.push(EXPERIENCE_LABELS[profile.experience_level] || profile.experience_level);
    }
    return parts.join(' · ');
  }, [profile]);

  const profileCompleteness = useMemo(() => {
    const checks = [
      { label: '身高', done: profile?.height != null },
      { label: '体重', done: profile?.weight != null },
      { label: '年龄', done: profile?.age != null },
      { label: '性别', done: profile?.gender != null },
      { label: '训练目标', done: goalCount > 0 },
      { label: '经验等级', done: !!profile?.experience_level },
    ];

    const doneCount = checks.filter((item) => item.done).length;
    const total = checks.length;
    const percent = Math.round((doneCount / total) * 100);
    const missing = checks.filter((item) => !item.done).map((item) => item.label);
    return { doneCount, total, percent, missing };
  }, [profile, goalCount]);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: Colors.background }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.primary} />}
    >
      {/* Profile Header */}
      <View style={styles.header}>
        <View style={[styles.avatar, { backgroundColor: Colors.primaryLight }]}>
          <Ionicons name="person" size={36} color={Colors.primary} />
        </View>
        <View style={styles.headerInfo}>
          <Text style={[styles.nickname, { color: Colors.text }]}>{user?.nickname || '健身爱好者'}</Text>
          {!!profileMeta && <Text style={[styles.metaText, { color: Colors.textSecondary }]}>{profileMeta}</Text>}
          <View style={styles.tagRow}>
            {goalCount > 0 && (
              <Badge label={`${goalCount} 个目标`} color={Colors.primary} />
            )}
            {profile?.experience_level && (
              <Badge label={EXPERIENCE_LABELS[profile.experience_level] || profile.experience_level} color={Colors.info} />
            )}
          </View>
        </View>
      </View>

      {profileCompleteness.percent < 100 && (
      <View style={[styles.completenessCard, { backgroundColor: Colors.surface, borderColor: Colors.borderLight }]}>
        <View style={styles.completenessHeader}>
          <Text style={[styles.completenessTitle, { color: Colors.text }]}>档案完整度</Text>
          <Text style={[styles.completenessPercent, { color: Colors.primary }]}>{profileCompleteness.percent}%</Text>
        </View>
        <View style={[styles.progressTrack, { backgroundColor: Colors.borderLight }]}>
          <View style={[styles.progressFill, { backgroundColor: Colors.primary, width: `${profileCompleteness.percent}%` }]} />
        </View>
        <Text style={[styles.completenessDesc, { color: Colors.textSecondary }]}>
          已完成 {profileCompleteness.doneCount}/{profileCompleteness.total} 项，完善档案可提升 AI 推荐准确度。
        </Text>
        <View style={styles.chipRow}>
          {profileCompleteness.missing.map((item) => (
            <View key={item} style={[styles.chip, { backgroundColor: Colors.warningLight }]}>
              <Text style={[styles.chipText, { color: Colors.warning }]}>{item}待完善</Text>
            </View>
          ))}
        </View>
      </View>
      )}

      {/* Stats */}
      {profile && (profile.height || profile.weight) && (
        <View style={[styles.statsCard, { backgroundColor: Colors.surface }]}>
          {[
            { label: '身高', value: profile.height, unit: 'cm' },
            { label: '体重', value: profile.weight, unit: 'kg' },
            { label: 'BMI', value: bmi, unit: '' },
            { label: '年龄', value: profile.age, unit: '岁' },
          ].map((item, i, arr) => (
            <View key={item.label} style={styles.statItemWrap}>
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: Colors.text }]}>
                  {item.value ?? '--'}
                  {item.value != null && item.unit ? (
                    <Text style={[styles.statUnit, { color: Colors.textTertiary }]}> {item.unit}</Text>
                  ) : null}
                </Text>
                <Text style={[styles.statLabel, { color: Colors.textTertiary }]}>{item.label}</Text>
              </View>
              {i < arr.length - 1 && <View style={[styles.statDivider, { backgroundColor: Colors.borderLight }]} />}
            </View>
          ))}
        </View>
      )}

      {/* Data Management */}
      <SectionHeader title="数据管理" />
      <Card style={styles.menuCard}>
        <ListItem
          icon="flag"
          iconColor={Colors.warning}
          title="训练目标"
          subtitle={goalCount > 0 ? `${goalCount} 个进行中` : '未设置'}
          onPress={() => router.push('/profile/training-goal')}
          right={goalCount > 0 ? <Badge label={String(goalCount)} color={Colors.warning} /> : undefined}
        />
        <View style={[styles.divider, { backgroundColor: Colors.borderLight }]} />
        <ListItem
          icon="body"
          iconColor={Colors.primary}
          title="身体数据"
          subtitle="身高、体重、年龄等"
          onPress={() => router.push('/profile/body-data')}
        />
        <View style={[styles.divider, { backgroundColor: Colors.borderLight }]} />
        <ListItem
          icon="analytics"
          iconColor={Colors.danger}
          title="理化指标"
          subtitle="血液检查、血压、血脂等"
          onPress={() => router.push('/profile/health-metrics')}
        />
        <View style={[styles.divider, { backgroundColor: Colors.borderLight }]} />
        <ListItem
          icon="bandage"
          iconColor={Colors.info}
          title="伤病记录"
          subtitle={conditionCount > 0 ? `${conditionCount} 项进行中` : '暂无记录'}
          onPress={() => router.push('/profile/conditions')}
          right={conditionCount > 0 ? <Badge label={String(conditionCount)} color={Colors.info} /> : undefined}
        />
      </Card>

      {/* History */}
      <SectionHeader title="历史记录" />
      <Card style={styles.menuCard}>
        <ListItem
          icon="barbell"
          iconColor={Colors.warning}
          title="训练记录"
          subtitle="AI 生成的训练计划"
          onPress={() => router.push('/profile/training-history')}
        />
        <View style={[styles.divider, { backgroundColor: Colors.borderLight }]} />
        <ListItem
          icon="restaurant"
          iconColor={Colors.success}
          title="饮食记录"
          subtitle="AI 生成的饮食方案"
          onPress={() => router.push('/profile/nutrition-history')}
        />
      </Card>

      {/* Account */}
      <SectionHeader title="账号设置" />
      <Card style={styles.menuCard}>
        <ListItem
          icon="lock-closed"
          iconColor={Colors.textSecondary}
          title="修改密码"
          onPress={() => router.push('/profile/change-password')}
        />
        <View style={[styles.divider, { backgroundColor: Colors.borderLight }]} />
        <ListItem
          icon="log-out-outline"
          iconColor={Colors.danger}
          title="退出登录"
          showChevron={false}
          destructive
          onPress={handleLogout}
        />
        <View style={[styles.divider, { backgroundColor: Colors.borderLight }]} />
        <ListItem
          icon="trash-outline"
          iconColor={Colors.danger}
          title="注销账号"
          subtitle="永久删除所有数据"
          showChevron={false}
          destructive
          onPress={handleDeleteAccount}
        />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xl, paddingBottom: 40 },

  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, marginBottom: Spacing.xl },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerInfo: { flex: 1 },
  nickname: { fontSize: FontSize.xxl, fontWeight: '600' },
  metaText: { fontSize: FontSize.sm, marginTop: 2 },
  tagRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },

  completenessCard: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  completenessHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  completenessTitle: { fontSize: FontSize.md, fontWeight: '700' },
  completenessPercent: { fontSize: FontSize.lg, fontWeight: '700' },
  progressTrack: {
    height: 8,
    borderRadius: Radius.full,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.full,
  },
  completenessDesc: { fontSize: FontSize.sm, marginBottom: Spacing.sm },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  chip: {
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  chipText: { fontSize: FontSize.xs, fontWeight: '600' },

  statsCard: {
    flexDirection: 'row',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    marginBottom: Spacing.xl,
  },
  statItemWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: { fontSize: FontSize.lg, fontWeight: '700' },
  statUnit: { fontSize: FontSize.xs, fontWeight: '400' },
  statLabel: { fontSize: FontSize.xs, marginTop: 2 },
  statDivider: { width: 1, height: 28, borderRadius: 1 },

  menuCard: { padding: 0, marginBottom: Spacing.lg, overflow: 'hidden' },
  divider: { height: 1, marginLeft: 64 },
});
