import { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Toast from 'react-native-toast-message';
import { api } from '../../services/api';
import { ProfileData } from '../../stores/profile';
import { Button, FormField, OptionPicker, LoadingScreen, ThemedInput } from '../../components/ui';
import { Spacing, FontSize, GENDER_LABELS, EXPERIENCE_LABELS } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { UpdateProfileRequest, Gender, ExperienceLevel } from '../../../shared/types';

export default function EditBodyDataScreen() {
  const router = useRouter();
  const Colors = useThemeColor();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<string | null>(null);
  const [experienceLevel, setExperienceLevel] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.getProfile();
        if (res.success && res.data) {
          const d = res.data as ProfileData;
          if (d.height) setHeight(String(d.height));
          if (d.weight) setWeight(String(d.weight));
          if (d.age) setAge(String(d.age));
          if (d.gender) setGender(d.gender);
          if (d.experience_level) setExperienceLevel(d.experience_level);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
    if (age) {
      const a = parseInt(age, 10);
      if (isNaN(a) || a < 1 || a > 150) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '年龄请输入 1~150' });
        return;
      }
    }

    setSaving(true);
    try {
      const data: UpdateProfileRequest = {};
      if (height) data.height = parseFloat(height);
      if (weight) data.weight = parseFloat(weight);
      if (age) data.age = parseInt(age, 10);
      if (gender) data.gender = gender as Gender;
      if (experienceLevel) data.experience_level = experienceLevel as ExperienceLevel;

      const res = await api.updateProfile(data);
      if (res.success) {
        Toast.show({ type: 'success', text1: '保存成功', text2: '身体数据已更新' });
        router.back();
      } else {
        Toast.show({ type: 'error', text1: '保存失败', text2: res.error || '未知错误' });
      }
    } catch {
      Toast.show({ type: 'error', text1: '保存失败', text2: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: true, title: '身体数据' }} />
      <ScrollView style={[styles.container, { backgroundColor: Colors.background }]} contentContainerStyle={styles.content}>
        <Text style={[styles.intro, { color: Colors.textTertiary }]}>
          完善你的身体数据，让 AI 教练更了解你，提供更精准的建议。
        </Text>

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

        <FormField label="年龄">
          <ThemedInput value={age} onChangeText={setAge} keyboardType="number-pad" placeholder="28" />
        </FormField>

        <FormField label="性别">
          <OptionPicker options={Object.entries(GENDER_LABELS).map(([value, label]) => ({ value, label }))} selected={gender} onSelect={setGender} />
        </FormField>

        <FormField label="训练经验">
          <OptionPicker options={Object.entries(EXPERIENCE_LABELS).map(([value, label]) => ({ value, label }))} selected={experienceLevel} onSelect={setExperienceLevel} color={Colors.info} />
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
  row: { flexDirection: 'row', gap: Spacing.lg },
  halfField: { flex: 1 },
  buttonContainer: { marginTop: Spacing.lg, marginBottom: 40 },
});
