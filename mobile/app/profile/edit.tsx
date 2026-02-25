import { useMemo, useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import Toast from 'react-native-toast-message';
import { api, getToken } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ProfileData } from '../../stores/profile';
import { Button, Card, FormField, OptionPicker, LoadingScreen, ThemedInput } from '../../components/ui';
import { API_BASE_URL, Spacing, FontSize, GENDER_LABELS, Gradients } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { UpdateProfileRequest, Gender } from '../../../shared/types';

const MAX_AVATAR_DIMENSION = 640;

function formatTrainingYears(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const isInt = Math.abs(rounded - Math.round(rounded)) < 1e-9;
  return isInt ? String(Math.round(rounded)) : rounded.toFixed(1);
}

export default function EditProfileScreen() {
  const router = useRouter();
  const Colors = useThemeColor();
  const { setUser } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const [nickname, setNickname] = useState('');
  const [avatarKey, setAvatarKey] = useState<string | null>(null);
  const [pendingAvatarUri, setPendingAvatarUri] = useState<string | null>(null);

  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState<string | null>(null);
  const [trainingYears, setTrainingYears] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [storedToken, meRes, profileRes] = await Promise.all([
          getToken(),
          api.getMe(),
          api.getProfile(),
        ]);

        setToken(storedToken);

        if (meRes.success && meRes.data) {
          const me = meRes.data as { nickname: string | null; avatar_key: string | null };
          if (me.nickname) setNickname(me.nickname);
          setAvatarKey(me.avatar_key ?? null);
        }

        if (profileRes.success && profileRes.data) {
          const d = profileRes.data as ProfileData;
          if (d.height != null) setHeight(String(d.height));
          if (d.weight != null) setWeight(String(d.weight));
          if (d.birth_date) setBirthDate(String(d.birth_date));
          if (d.gender) setGender(d.gender);
          if (d.training_years != null) setTrainingYears(String(d.training_years));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const avatarSource = useMemo(() => {
    if (pendingAvatarUri) return { uri: pendingAvatarUri };
    if (!avatarKey) return null;
    const uri = `${API_BASE_URL}/api/images/${avatarKey}`;
    return token ? { uri, headers: { Authorization: `Bearer ${token}` } } : { uri };
  }, [pendingAvatarUri, avatarKey, token]);

  const avatarInitial = useMemo(() => {
    const n = nickname.trim();
    if (n) return n.slice(0, 1);
    return '练';
  }, [nickname]);

  const resizeAvatarIfNeeded = async (uri: string): Promise<string | null> => {
    try {
      const result = await manipulateAsync(
        uri,
        [{ resize: { width: MAX_AVATAR_DIMENSION } }],
        { compress: 0.8, format: SaveFormat.JPEG }
      );
      return result.uri;
    } catch {
      return null;
    }
  };

  const handlePickAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Toast.show({ type: 'error', text1: '权限不足', text2: '需要相册访问权限' });
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
      allowsEditing: true,
      aspect: [1, 1],
    });

    if (result.canceled || !result.assets[0]) return;
    const resized = await resizeAvatarIfNeeded(result.assets[0].uri);
    if (!resized) {
      Toast.show({ type: 'error', text1: '处理失败', text2: '图片处理失败，请重试' });
      return;
    }
    setPendingAvatarUri(resized);
  };

  const handleRemoveAvatar = () => {
    setPendingAvatarUri(null);
    setAvatarKey(null);
    Toast.show({ type: 'success', text1: '已移除头像', text2: '点击保存后生效' });
  };

  const handleSave = async () => {
    if (height) {
      const h = parseFloat(height);
      if (isNaN(h) || h < 50 || h > 300) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '身高请输入 50~300 cm' });
        return;
      }
    }
    if (weight) {
      const w = parseFloat(weight);
      if (isNaN(w) || w < 20 || w > 500) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '体重请输入 20~500 kg' });
        return;
      }
    }
    if (birthDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '出生年月日格式应为 YYYY-MM-DD' });
        return;
      }
    }
    if (trainingYears) {
      const y = parseFloat(trainingYears);
      if (isNaN(y) || y < 0 || y > 80) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '训练年限请输入 0~80 年' });
        return;
      }
    }

    setSaving(true);
    try {
      const updates: Array<{ ok: boolean; error?: string }> = [];

      // 1) 上传头像（如有）
      let uploadedAvatarKey: string | null | undefined = undefined;
      if (pendingAvatarUri) {
        const upload = await api.uploadImage(pendingAvatarUri);
        if (!upload.success || !upload.data?.key) {
          Toast.show({ type: 'error', text1: '上传失败', text2: upload.error || '头像上传失败' });
          return;
        }
        uploadedAvatarKey = upload.data.key;
      }

      // 2) 更新用户基础信息（昵称/头像）
      const mePatch: { nickname?: string | null; avatar_key?: string | null } = {};
      const normalizedNickname = nickname.trim();
      mePatch.nickname = normalizedNickname ? normalizedNickname : null;
      if (uploadedAvatarKey !== undefined) mePatch.avatar_key = uploadedAvatarKey;
      if (uploadedAvatarKey === undefined && avatarKey === null) mePatch.avatar_key = null;

      if (Object.keys(mePatch).length > 0) {
        const meRes = await api.updateMe(mePatch);
        if (!meRes.success || !meRes.data) {
          Toast.show({ type: 'error', text1: '保存失败', text2: meRes.error || '用户信息更新失败' });
          return;
        }
        const nextUser = meRes.data as { id: string; email: string; nickname: string | null; avatar_key: string | null };
        setUser(nextUser);
        setAvatarKey(nextUser.avatar_key);
        setPendingAvatarUri(null);
        updates.push({ ok: true });
      }

      // 3) 更新身体数据
      const profilePatch: UpdateProfileRequest = {};
      if (height) profilePatch.height = parseFloat(height);
      if (weight) profilePatch.weight = parseFloat(weight);
      if (birthDate) profilePatch.birth_date = birthDate;
      if (gender) profilePatch.gender = gender as Gender;
      if (trainingYears) profilePatch.training_years = parseFloat(trainingYears);

      if (Object.keys(profilePatch).length > 0) {
        const res = await api.updateProfile(profilePatch);
        if (!res.success) {
          Toast.show({ type: 'error', text1: '保存失败', text2: res.error || '身体数据更新失败' });
          return;
        }
        updates.push({ ok: true });
      }

      if (updates.length === 0) {
        Toast.show({ type: 'success', text1: '无需保存', text2: '没有检测到改动' });
        router.replace('/(tabs)/profile');
        return;
      }

      Toast.show({ type: 'success', text1: '保存成功', text2: '个人资料已更新' });
      router.replace('/(tabs)/profile');
    } catch {
      Toast.show({ type: 'error', text1: '保存失败', text2: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: true, title: '编辑资料' }} />
      <ScrollView style={[styles.container, { backgroundColor: Colors.background }]} contentContainerStyle={styles.content}>
        <Text style={[styles.intro, { color: Colors.textTertiary }]}>
          点击头像和昵称即可修改。完善基础信息，让 AI 建议更贴近你的实际情况。
        </Text>

        <Card style={[styles.avatarCard, { backgroundColor: Colors.surface }]}>
          <View style={styles.avatarRow}>
            <LinearGradient
              colors={[...Gradients.hero]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatarRing}
            >
              <View style={styles.avatarInner}>
                {avatarSource ? (
                  <Image source={avatarSource} style={styles.avatarImage} />
                ) : (
                  <Text style={[styles.avatarInitial, { color: Colors.primary }]}>{avatarInitial}</Text>
                )}
              </View>
            </LinearGradient>

            <View style={{ flex: 1 }}>
              <Text style={[styles.avatarTitle, { color: Colors.text }]}>头像与昵称</Text>
              <Text style={[styles.avatarHint, { color: Colors.textTertiary }]}>
                头像用于展示，昵称用于个性化称呼
              </Text>
            </View>
          </View>

          <View style={styles.avatarActions}>
            <Button title="更换头像" onPress={handlePickAvatar} variant="outline" />
            <Button title="移除头像" onPress={handleRemoveAvatar} variant="ghost" color={Colors.textSecondary} />
          </View>

          <FormField label="昵称">
            <ThemedInput value={nickname} onChangeText={setNickname} placeholder="请输入昵称（可留空）" />
          </FormField>
        </Card>

        <View style={styles.row}>
          <View style={styles.halfField}>
            <FormField label="身高 (cm)">
              <ThemedInput value={height} onChangeText={setHeight} keyboardType="decimal-pad" placeholder="178" />
            </FormField>
          </View>
          <View style={styles.halfField}>
            <FormField label="体重 (kg)">
              <ThemedInput value={weight} onChangeText={setWeight} keyboardType="decimal-pad" placeholder="75" />
            </FormField>
          </View>
        </View>

        <FormField label="出生年月日 (YYYY-MM-DD)">
          <ThemedInput value={birthDate} onChangeText={setBirthDate} placeholder="1998-06-18" autoCapitalize="none" />
        </FormField>

        <FormField label="性别">
          <OptionPicker options={Object.entries(GENDER_LABELS).map(([value, label]) => ({ value, label }))} selected={gender} onSelect={setGender} />
        </FormField>

        <FormField label="训练年限 (年)">
          <ThemedInput value={trainingYears} onChangeText={setTrainingYears} keyboardType="decimal-pad" placeholder="2" />
          {trainingYears ? (
            <Text style={[styles.hint, { color: Colors.textTertiary }]}>
              当前：{formatTrainingYears(parseFloat(trainingYears) || 0)} 年
            </Text>
          ) : null}
        </FormField>

        <View style={styles.buttonContainer}>
          <Button title="保存" onPress={handleSave} loading={saving} size="lg" />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xl },
  intro: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.xxl },
  avatarCard: { padding: Spacing.lg, marginBottom: Spacing.xl },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, marginBottom: Spacing.md },
  avatarRing: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center' },
  avatarInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#FFFFFF', overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
  avatarImage: { width: 62, height: 62, borderRadius: 31 },
  avatarInitial: { fontSize: 26, fontWeight: '700' },
  avatarTitle: { fontSize: FontSize.md, fontWeight: '700' },
  avatarHint: { fontSize: FontSize.sm, marginTop: 2 },
  avatarActions: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.lg },
  row: { flexDirection: 'row', gap: Spacing.lg },
  halfField: { flex: 1 },
  hint: { fontSize: FontSize.xs, marginTop: Spacing.xs },
  buttonContainer: { marginTop: Spacing.lg, marginBottom: 40 },
});
