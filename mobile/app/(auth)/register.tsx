import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Link } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import { useAuthStore } from '../../stores/auth';
import { Spacing, FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { Button, ThemedInput } from '../../components/ui';

export default function RegisterScreen() {
  const Colors = useThemeColor();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const { register, isLoading } = useAuthStore();

  const handleRegister = async () => {
    if (!email || !password) {
      Toast.show({ type: 'error', text1: '提示', text2: '请输入邮箱和密码' });
      return;
    }
    if (password.length < 8) {
      Toast.show({ type: 'error', text1: '提示', text2: '密码至少 8 位' });
      return;
    }
    try {
      await register(email, password, nickname || undefined);
    } catch (err) {
      Toast.show({ type: 'error', text1: '注册失败', text2: err instanceof Error ? err.message : '未知错误' });
    }
  };

  return (
    <LinearGradient
      colors={[Colors.primaryLight, Colors.background]}
      locations={[0, 0.5]}
      style={styles.gradient}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: Colors.text }]}>创建账号</Text>
            <Text style={[styles.subtitle, { color: Colors.textTertiary }]}>开始你的智能健身之旅</Text>
          </View>

          <View style={styles.form}>
            <ThemedInput
              value={nickname}
              onChangeText={setNickname}
              placeholder="昵称（可选）"
              accessibilityLabel="昵称输入框"
            />
            <ThemedInput
              value={email}
              onChangeText={setEmail}
              placeholder="邮箱"
              keyboardType="email-address"
              autoCapitalize="none"
              accessibilityLabel="邮箱输入框"
            />
            <ThemedInput
              value={password}
              onChangeText={setPassword}
              placeholder="密码（至少 8 位）"
              secureTextEntry
              accessibilityLabel="密码输入框"
            />

            <Button title={isLoading ? '注册中...' : '注册'} onPress={handleRegister} loading={isLoading} size="lg" />
          </View>

          <Link href="/(auth)/login" asChild>
            <TouchableOpacity style={styles.linkButton} activeOpacity={0.6} accessibilityRole="link" accessibilityLabel="前往登录页面">
              <Text style={[styles.linkText, { color: Colors.textTertiary }]}>
                已有账号？<Text style={[styles.linkHighlight, { color: Colors.primary }]}>去登录</Text>
              </Text>
            </TouchableOpacity>
          </Link>
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: Spacing.xxxl },

  header: { marginBottom: 48 },
  title: { fontSize: FontSize.hero, fontWeight: '700', marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.md },

  form: { gap: Spacing.lg, marginBottom: Spacing.xxl },

  linkButton: { alignItems: 'center' },
  linkText: { fontSize: FontSize.sm },
  linkHighlight: { fontWeight: '600' },
});
