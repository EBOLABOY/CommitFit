import * as SecureStore from 'expo-secure-store';

function toKey(userId: string): string {
  return `ai_custom_api_key:${userId}`;
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
