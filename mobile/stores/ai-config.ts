import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MobileAIConfig, MobileAIProvider, MobileAIResolvedConfig } from '@shared/types';

const DEFAULT_PRIMARY_MODEL = '@cf/zai-org/glm-4.7-flash';
const DEFAULT_FALLBACK_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const AI_CONFIG_PERSIST_VERSION = 2;

function sanitizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  return value.replace(/\/$/, '');
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function resolveConfig(config: MobileAIConfig): MobileAIResolvedConfig {
  const customReady =
    config.provider === 'custom'
    && isNonEmpty(config.custom_base_url)
    && isNonEmpty(config.custom_primary_model)
    && isNonEmpty(config.custom_fallback_model)
    && config.custom_api_key_configured;

  return {
    ...config,
    effective_provider: customReady ? 'custom' : 'workers',
    custom_ready: customReady,
  };
}

interface AIConfigState {
  config: MobileAIConfig;
  resolved: MobileAIResolvedConfig;

  setProvider: (provider: MobileAIProvider) => void;
  updateCustomConfig: (input: {
    custom_base_url?: string;
    custom_primary_model?: string;
    custom_fallback_model?: string;
  }) => void;
  setCustomApiKeyConfigured: (configured: boolean) => void;
  reset: () => void;
}

const defaultConfig: MobileAIConfig = {
  provider: 'workers',
  custom_base_url: '',
  custom_primary_model: DEFAULT_PRIMARY_MODEL,
  custom_fallback_model: DEFAULT_FALLBACK_MODEL,
  custom_api_key_configured: false,
};

function normalizeConfig(raw: unknown): MobileAIConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultConfig;
  const obj = raw as Record<string, unknown>;

  const provider = obj.provider === 'custom' ? 'custom' : 'workers';
  const customBaseUrl = typeof obj.custom_base_url === 'string' ? sanitizeBaseUrl(obj.custom_base_url) : '';

  // 兼容旧字段：custom_worker_model/custom_planner_model
  const primaryModelRaw = typeof obj.custom_primary_model === 'string'
    ? obj.custom_primary_model
    : (typeof obj.custom_worker_model === 'string' ? obj.custom_worker_model : '');
  const fallbackModelRaw = typeof obj.custom_fallback_model === 'string'
    ? obj.custom_fallback_model
    : (typeof obj.custom_planner_model === 'string' ? obj.custom_planner_model : '');

  return {
    provider,
    custom_base_url: customBaseUrl,
    custom_primary_model: primaryModelRaw.trim() || DEFAULT_PRIMARY_MODEL,
    custom_fallback_model: fallbackModelRaw.trim() || DEFAULT_FALLBACK_MODEL,
    custom_api_key_configured: obj.custom_api_key_configured === true,
  };
}

export const useAIConfigStore = create<AIConfigState>()(
  persist(
    (set, get) => ({
      config: defaultConfig,
      resolved: resolveConfig(defaultConfig),

      setProvider: (provider) => {
        const next = { ...get().config, provider };
        set({ config: next, resolved: resolveConfig(next) });
      },

      updateCustomConfig: (input) => {
        const prev = get().config;
        const next: MobileAIConfig = {
          ...prev,
          custom_base_url: input.custom_base_url !== undefined
            ? sanitizeBaseUrl(input.custom_base_url)
            : prev.custom_base_url,
          custom_primary_model: input.custom_primary_model !== undefined
            ? input.custom_primary_model.trim()
            : prev.custom_primary_model,
          custom_fallback_model: input.custom_fallback_model !== undefined
            ? input.custom_fallback_model.trim()
            : prev.custom_fallback_model,
        };
        set({ config: next, resolved: resolveConfig(next) });
      },

      setCustomApiKeyConfigured: (configured) => {
        const next = { ...get().config, custom_api_key_configured: configured };
        set({ config: next, resolved: resolveConfig(next) });
      },

      reset: () => {
        set({ config: defaultConfig, resolved: resolveConfig(defaultConfig) });
      },
    }),
    {
      name: 'lianlema-ai-config',
      version: AI_CONFIG_PERSIST_VERSION,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ config: state.config }),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return { config: defaultConfig };
        }
        const rawConfig = (persistedState as { config?: unknown }).config;
        return { config: normalizeConfig(rawConfig) };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.config = normalizeConfig(state.config);
        state.resolved = resolveConfig(state.config);
      },
    }
  )
);

export function getResolvedAIConfig(): MobileAIResolvedConfig {
  return useAIConfigStore.getState().resolved;
}
