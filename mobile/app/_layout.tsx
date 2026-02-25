import { Stack } from 'expo-router';
import { useEffect, useState, useCallback } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import * as SystemUI from 'expo-system-ui';
import { useAuthStore } from '../stores/auth';
import { getToken, clearToken, api } from '../services/api';
import { useRouter, useSegments } from 'expo-router';
import { LoadingScreen } from '../components/ui';
import { useThemeColor } from '../hooks/useThemeColor';
import Toast from 'react-native-toast-message';
import { toastConfig } from '../components/ToastConfig';
import { useWritebackOutboxStore } from '../stores/writeback-outbox';

export default function RootLayout() {
  const { isAuthenticated, setUser } = useAuthStore();
  const segments = useSegments();
  const router = useRouter();
  const Colors = useThemeColor();
  const colorScheme = useColorScheme();
  const [isReady, setIsReady] = useState(false);
  const flushWritebackOutbox = useWritebackOutboxStore((s) => s.flush);

  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // 设置根背景色
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(Colors.background);
  }, [Colors.background]);

  // Validate existing token on mount
  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (token) {
        try {
          const res = await api.getMe();
          if (res.success && res.data) {
            const user = res.data as { id: string; email: string; nickname: string | null; avatar_key: string | null };
            setUser(user);
          } else {
            await clearToken();
          }
        } catch {
          await clearToken();
        }
      }
      setIsReady(true);
    })();
  }, [setUser]);

  // Route protection
  useEffect(() => {
    if (!isReady) return;
    const inAuthGroup = segments[0] === '(auth)';

    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [isAuthenticated, segments, router, isReady]);

  // Local-First：应用启动/网络恢复后自动 flush Outbox，把草稿幂等提交到远端
  useEffect(() => {
    if (!isReady || !isAuthenticated) return;
    void flushWritebackOutbox();
    const timer = setInterval(() => {
      void flushWritebackOutbox();
    }, 15_000);
    return () => clearInterval(timer);
  }, [isReady, isAuthenticated, flushWritebackOutbox]);

  if (!isReady || !fontsLoaded) return <LoadingScreen />;

  return (
    <>
      <StatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={Colors.background} />
      <Stack
        screenOptions={{
          headerShown: false,
          headerBackTitle: '返回',
          headerTintColor: Colors.text,
          headerStyle: { backgroundColor: Colors.background },
          contentStyle: { backgroundColor: Colors.background },
        }}
      >
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="profile/edit"
          options={{ headerShown: true, title: '编辑资料' }}
        />
        <Stack.Screen
          name="profile/health-metrics"
          options={{ headerShown: true, title: '理化指标' }}
        />
        <Stack.Screen
          name="profile/conditions"
          options={{ headerShown: true, title: '伤病记录' }}
        />
        <Stack.Screen
          name="profile/training-goal"
          options={{ headerShown: true, title: '训练目标' }}
        />
        <Stack.Screen
          name="profile/diet-plan"
          options={{ headerShown: true, title: '饮食方案' }}
        />
        <Stack.Screen
          name="profile/supplement-plan"
          options={{ headerShown: true, title: '补剂方案' }}
        />
        <Stack.Screen
          name="profile/training-history"
          options={{ headerShown: true, title: '训练记录' }}
        />
        <Stack.Screen
          name="profile/nutrition-history"
          options={{ headerShown: true, title: '饮食记录' }}
        />
        <Stack.Screen
          name="profile/change-password"
          options={{ headerShown: true, title: '修改密码' }}
        />
        <Stack.Screen
          name="diet/record"
          options={{ headerShown: true, title: '记录饮食' }}
        />
      </Stack>
      <Toast config={toastConfig} />
    </>
  );
}
