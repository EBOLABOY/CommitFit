import { useMemo, useState } from 'react';
import { View, ScrollView, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Stack } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Button, FormField, ThemedInput, Card } from '../../components/ui';
import { Spacing, Radius, FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useAIConfigStore } from '../../stores/ai-config';
import { useAuthStore } from '../../stores/auth';
import { clearCustomAIKey, setCustomAIKey } from '../../services/ai-config-secure';
import type { MobileAIProvider } from '@shared/types';

function ProviderChip({
  active,
  title,
  subtitle,
  onPress,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const Colors = useThemeColor();
  return (
    <TouchableOpacity
      style={[
        styles.providerChip,
        {
          borderColor: active ? Colors.primary : Colors.border,
          backgroundColor: active ? Colors.primaryLight : Colors.surface,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Text style={[styles.providerTitle, { color: active ? Colors.primary : Colors.text }]}>{title}</Text>
      <Text style={[styles.providerSubtitle, { color: Colors.textSecondary }]}>{subtitle}</Text>
    </TouchableOpacity>
  );
}

export default function AISettingsScreen() {
  const Colors = useThemeColor();
  const user = useAuthStore((s) => s.user);
  const { config, resolved, setProvider, updateCustomConfig, setCustomApiKeyConfigured } = useAIConfigStore();

  const [provider, setProviderLocal] = useState<MobileAIProvider>(config.provider);
  const [baseUrl, setBaseUrl] = useState(config.custom_base_url);
  const [primaryModel, setPrimaryModel] = useState(config.custom_primary_model);
  const [fallbackModel, setFallbackModel] = useState(config.custom_fallback_model);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const providerHint = useMemo(() => {
    if (resolved.effective_provider === 'custom') {
      return `当前生效：自定义代理（主:${resolved.custom_primary_model} / 备:${resolved.custom_fallback_model}）`;
    }
    return '当前生效：Workers AI（默认）';
  }, [resolved]);

  const validateCustom = (): boolean => {
    if (provider !== 'custom') return true;
    if (!baseUrl.trim()) {
      Toast.show({ type: 'error', text1: '配置不完整', text2: '请填写代理地址' });
      return false;
    }
    if (!primaryModel.trim()) {
      Toast.show({ type: 'error', text1: '配置不完整', text2: '请填写主模型' });
      return false;
    }
    if (!fallbackModel.trim()) {
      Toast.show({ type: 'error', text1: '配置不完整', text2: '请填写备用模型' });
      return false;
    }
    if (!config.custom_api_key_configured && !apiKey.trim()) {
      Toast.show({ type: 'error', text1: '配置不完整', text2: '请填写 API Key' });
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validateCustom()) return;
    setSaving(true);
    try {
      updateCustomConfig({
        custom_base_url: baseUrl,
        custom_primary_model: primaryModel,
        custom_fallback_model: fallbackModel,
      });

      if (provider === 'custom' && apiKey.trim()) {
        if (!user?.id) {
          Toast.show({ type: 'error', text1: '保存失败', text2: '用户未登录，无法保存密钥' });
          return;
        }
        await setCustomAIKey(user.id, apiKey.trim());
        setCustomApiKeyConfigured(true);
        setApiKey('');
      }

      setProvider(provider);
      Toast.show({ type: 'success', text1: '已保存', text2: 'AI 配置已更新' });
    } catch {
      Toast.show({ type: 'error', text1: '保存失败', text2: '请稍后重试' });
    } finally {
      setSaving(false);
    }
  };

  const handleClearApiKey = async () => {
    if (!user?.id) {
      Toast.show({ type: 'error', text1: '失败', text2: '用户未登录' });
      return;
    }
    try {
      await clearCustomAIKey(user.id);
      setCustomApiKeyConfigured(false);
      Toast.show({ type: 'success', text1: '已清除', text2: '自定义 API Key 已删除' });
    } catch {
      Toast.show({ type: 'error', text1: '失败', text2: '清除密钥失败' });
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: Colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: 'AI 配置' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={[styles.sectionTitle, { color: Colors.text }]}>Provider 选择</Text>
          <View style={styles.providerRow}>
            <ProviderChip
              active={provider === 'workers'}
              title="Workers AI"
              subtitle="默认主链路"
              onPress={() => setProviderLocal('workers')}
            />
            <ProviderChip
              active={provider === 'custom'}
              title="自定义代理"
              subtitle="OpenAI 兼容"
              onPress={() => setProviderLocal('custom')}
            />
          </View>
          <Text style={[styles.hintText, { color: Colors.textSecondary }]}>{providerHint}</Text>
        </Card>

        <Card style={styles.cardGap}>
          <Text style={[styles.sectionTitle, { color: Colors.text }]}>自定义代理（可选）</Text>
          <FormField label="代理地址" hint="例如 https://your-proxy/v1">
            <ThemedInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://your-proxy/v1"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </FormField>
          <FormField label="主模型" hint="默认优先使用">
            <ThemedInput
              value={primaryModel}
              onChangeText={setPrimaryModel}
              placeholder="例如 gpt-4o-mini"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </FormField>
          <FormField label="备用模型" hint="主模型失败时自动降级">
            <ThemedInput
              value={fallbackModel}
              onChangeText={setFallbackModel}
              placeholder="例如 gpt-4.1"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </FormField>
          <FormField
            label="API Key"
            hint={config.custom_api_key_configured ? '已配置密钥；留空表示不变更' : '将加密保存到 SecureStore'}
          >
            <ThemedInput
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={config.custom_api_key_configured ? '••••••••••••' : '输入 API Key'}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </FormField>
          {config.custom_api_key_configured && (
            <TouchableOpacity style={[styles.clearButton, { borderColor: Colors.danger }]} onPress={handleClearApiKey}>
              <Text style={[styles.clearButtonText, { color: Colors.danger }]}>清除已保存的 API Key</Text>
            </TouchableOpacity>
          )}
        </Card>

        <View style={styles.saveWrap}>
          <Button title="保存配置" onPress={handleSave} loading={saving} size="lg" />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.xl, paddingBottom: 50 },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.md },
  providerRow: { gap: Spacing.sm },
  providerChip: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  providerTitle: { fontSize: FontSize.md, fontWeight: '700' },
  providerSubtitle: { marginTop: 2, fontSize: FontSize.sm },
  hintText: { marginTop: Spacing.sm, fontSize: FontSize.sm },
  cardGap: { marginTop: Spacing.lg },
  clearButton: {
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
  },
  clearButtonText: { fontSize: FontSize.sm, fontWeight: '600' },
  saveWrap: { marginTop: Spacing.lg },
});
