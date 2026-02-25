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
import { Spacing, FontSize, Gradients } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { Button, ThemedInput } from '../../components/ui';

export default function LoginScreen() {
  const Colors = useThemeColor();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, isLoading } = useAuthStore();

  const handleLogin = async () => {
    if (!email || !password) {
      Toast.show({ type: 'error', text1: '提示', text2: '请输入邮箱和密码' });
      return;
    }
    try {
      await login(email, password);
    } catch (err) {
      Toast.show({ type: 'error', text1: '登录失败', text2: err instanceof Error ? err.message : '未知错误' });
    }
  };

  return (
    <LinearGradient
      colors={[...Gradients.heroLight, Colors.background]}
      locations={[0, 0.4, 1]}
      style={styles.gradient}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.content}>
          <View style={styles.logoArea}>
            <View style={[styles.logoCircle, { backgroundColor: Colors.primary + '18' }]}>
              <Text style={styles.logoEmoji}>💪</Text>
            </View>
            <Text style={[styles.title, { color: Colors.text }]}>练了码</Text>
            <Text style={[styles.subtitle, { color: Colors.textTertiary }]}>AI 驱动的智能健身助手</Text>
          </View>

          <View style={styles.form}>
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
              placeholder="密码"
              secureTextEntry
              accessibilityLabel="密码输入框"
            />

            <Button title={isLoading ? '登录中...' : '登录'} onPress={handleLogin} loading={isLoading} size="lg" />
          </View>

          <Link href="/(auth)/register" asChild>
            <TouchableOpacity style={styles.linkButton} activeOpacity={0.6} accessibilityRole="link" accessibilityLabel="前往注册页面">
              <Text style={[styles.linkText, { color: Colors.textTertiary }]}>
                没有账号？<Text style={[styles.linkHighlight, { color: Colors.primary }]}>立即注册</Text>
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

  logoArea: { alignItems: 'center', marginBottom: 48 },
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  logoEmoji: { fontSize: 36 },
  title: { fontSize: FontSize.hero, fontWeight: '700', marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.md },

  form: { gap: Spacing.lg, marginBottom: Spacing.xxl },

  linkButton: { alignItems: 'center' },
  linkText: { fontSize: FontSize.sm },
  linkHighlight: { fontWeight: '600' },
});
