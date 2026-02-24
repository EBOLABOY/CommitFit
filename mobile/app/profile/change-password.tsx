import { useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Toast from 'react-native-toast-message';
import { api, setToken } from '../../services/api';
import { Button, FormField, ThemedInput } from '../../components/ui';
import { Spacing } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';

export default function ChangePasswordScreen() {
  const router = useRouter();
  const Colors = useThemeColor();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) {
      Toast.show({ type: 'error', text1: '提示', text2: '请填写所有字段' });
      return;
    }
    if (newPassword.length < 8) {
      Toast.show({ type: 'error', text1: '提示', text2: '新密码至少 8 位' });
      return;
    }
    if (newPassword !== confirmPassword) {
      Toast.show({ type: 'error', text1: '提示', text2: '两次输入的新密码不一致' });
      return;
    }
    if (oldPassword === newPassword) {
      Toast.show({ type: 'error', text1: '提示', text2: '新密码不能与旧密码相同' });
      return;
    }

    setSaving(true);
    try {
      const res = await api.changePassword(oldPassword, newPassword);
      if (res.success) {
        const data = res.data as { token: string } | undefined;
        if (data?.token) await setToken(data.token);
        Toast.show({ type: 'success', text1: '修改成功', text2: '密码已更新' });
        router.back();
      } else {
        Toast.show({ type: 'error', text1: '修改失败', text2: res.error || '未知错误' });
      }
    } catch {
      Toast.show({ type: 'error', text1: '修改失败', text2: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: true, title: '修改密码' }} />
      <ScrollView style={[styles.container, { backgroundColor: Colors.background }]} contentContainerStyle={styles.content}>
        <FormField label="当前密码">
          <ThemedInput value={oldPassword} onChangeText={setOldPassword} secureTextEntry placeholder="输入当前密码" />
        </FormField>
        <FormField label="新密码" hint="至少 8 位">
          <ThemedInput value={newPassword} onChangeText={setNewPassword} secureTextEntry placeholder="输入新密码" />
        </FormField>
        <FormField label="确认新密码">
          <ThemedInput value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry placeholder="再次输入新密码" />
        </FormField>
        <View style={styles.buttonContainer}>
          <Button title="修改密码" onPress={handleSave} loading={saving} size="lg" />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xl },
  buttonContainer: { marginTop: Spacing.lg, marginBottom: 40 },
});
