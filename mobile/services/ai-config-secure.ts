import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'ai_custom_api_key';
const INVALID_KEY_CHAR_REGEX = /[^\w.-]/g;

function sanitizeUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed) return 'anonymous';
  return trimmed.replace(INVALID_KEY_CHAR_REGEX, '_');
}

function toKey(userId: string): string {
  return `${KEY_PREFIX}.${sanitizeUserId(userId)}`;
}

export async function setCustomAIKey(userId: string, apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(toKey(userId), apiKey);
}

export async function getCustomAIKey(userId: string): Promise<string | null> {
  return SecureStore.getItemAsync(toKey(userId));
}

export async function clearCustomAIKey(userId: string): Promise<void> {
  await SecureStore.deleteItemAsync(toKey(userId));
}
