import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../constants';
import type {
  AgentRuntimeContextResponse,
  UpdateProfileRequest,
  CreateHealthMetricRequest,
  CreateConditionRequest,
  CreateTrainingGoalRequest,
  CreateDietRecordRequest,
  UpsertDailyLogRequest,
  WritebackRequestMeta,
  WritebackCommitResponseData,
} from '@shared/types';

let authToken: string | null = null;

export async function getToken(): Promise<string | null> {
  if (authToken) return authToken;
  authToken = await SecureStore.getItemAsync('auth_token');
  return authToken;
}

export async function setToken(token: string): Promise<void> {
  authToken = token;
  await SecureStore.setItemAsync('auth_token', token);
}

export async function clearToken(): Promise<void> {
  authToken = null;
  await SecureStore.deleteItemAsync('auth_token');
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data?: T; error?: string }> {
  const token = await getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });

    const raw = await response.text();
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      if (parsed && typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        const errorText = typeof obj.error === 'string'
          ? obj.error
          : typeof obj.message === 'string'
            ? obj.message
            : `请求失败（${response.status}）`;
        return { success: false, error: errorText };
      }
      return { success: false, error: `请求失败（${response.status}）` };
    }

    if (parsed && typeof parsed === 'object' && 'success' in (parsed as Record<string, unknown>)) {
      return parsed as { success: boolean; data?: T; error?: string };
    }

    return { success: true, data: parsed as T };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络请求失败' };
  }
}

// Auth
export const api = {
  // Auth
  register: (email: string, password: string, nickname?: string) =>
    request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, nickname }),
    }),

  login: (email: string, password: string) =>
    request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  getMe: () => request('/api/auth/me'),
  updateMe: (data: { nickname?: string | null; avatar_key?: string | null }) =>
    request('/api/auth/me', { method: 'PUT', body: JSON.stringify(data) }),

  changePassword: (oldPassword: string, newPassword: string) =>
    request('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }),

  deleteAccount: () =>
    request('/api/auth/account', { method: 'DELETE' }),

  // Profile
  getProfile: () => request('/api/profile'),
  updateProfile: (data: UpdateProfileRequest) =>
    request('/api/profile', { method: 'PUT', body: JSON.stringify(data) }),

  // Health Metrics
  getHealthMetrics: (metricType?: string) =>
    request(`/api/health${metricType ? `?metric_type=${metricType}` : ''}`),
  createHealthMetric: (data: CreateHealthMetricRequest) =>
    request('/api/health', { method: 'POST', body: JSON.stringify(data) }),
  deleteHealthMetric: (id: string) =>
    request(`/api/health/${id}`, { method: 'DELETE' }),

  // Conditions
  getConditions: (status?: string) =>
    request(`/api/conditions${status ? `?status=${status}` : ''}`),
  createCondition: (data: CreateConditionRequest) =>
    request('/api/conditions', { method: 'POST', body: JSON.stringify(data) }),
  updateCondition: (id: string, data: { status?: string; name?: string; description?: string; severity?: string }) =>
    request(`/api/conditions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCondition: (id: string) =>
    request(`/api/conditions/${id}`, { method: 'DELETE' }),

  // Training Goals
  getTrainingGoals: (status?: string) =>
    request(`/api/training-goals${status ? `?status=${status}` : ''}`),
  createTrainingGoal: (data: CreateTrainingGoalRequest) =>
    request('/api/training-goals', { method: 'POST', body: JSON.stringify(data) }),
  updateTrainingGoal: (id: string, data: { name?: string; description?: string; status?: string }) =>
    request(`/api/training-goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTrainingGoal: (id: string) =>
    request(`/api/training-goals/${id}`, { method: 'DELETE' }),

  // Training
  getTrainingPlans: (limit?: number) =>
    request(`/api/training${limit ? `?limit=${limit}` : ''}`),
  createTrainingPlan: (data: { plan_date: string; content: string; notes?: string }) =>
    request('/api/training', { method: 'POST', body: JSON.stringify(data) }),
  completeTrainingPlan: (id: string) =>
    request(`/api/training/${id}/complete`, { method: 'PUT' }),

  // Nutrition
  getNutritionPlans: (limit?: number) =>
    request(`/api/nutrition${limit ? `?limit=${limit}` : ''}`),

  // Image upload
  uploadImage: async (uri: string): Promise<{ success: boolean; data?: { key: string }; error?: string }> => {
    const token = await getToken();
    const formData = new FormData();
    formData.append('image', {
      uri,
      type: 'image/jpeg',
      name: 'image.jpg',
    } as unknown as Blob);

    const response = await fetch(`${API_BASE_URL}/api/images/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return response.json();
  },

  // Diet
  analyzeFoodAI: (data: { description?: string; image?: string; image_key?: string }) =>
    request('/api/diet/analyze', { method: 'POST', body: JSON.stringify(data) }),

  getDietRecords: (date?: string) =>
    request(`/api/diet${date ? `?date=${date}` : ''}`),

  createDietRecord: (data: CreateDietRecordRequest) =>
    request('/api/diet', { method: 'POST', body: JSON.stringify(data) }),

  deleteDietRecord: (id: string) =>
    request(`/api/diet/${id}`, { method: 'DELETE' }),

  // Daily Logs (weight, sleep)
  getDailyLog: (date: string) =>
    request(`/api/daily-logs?date=${date}`),
  getDailyLogs: (limit?: number) =>
    request(`/api/daily-logs${limit ? `?limit=${limit}` : ''}`),
  upsertDailyLog: (data: UpsertDailyLogRequest) =>
    request('/api/daily-logs', { method: 'PUT', body: JSON.stringify(data) }),

  // Local-First writeback commit (idempotent)
  commitWriteback: (data: {
    draft_id: string;
    payload: Record<string, unknown>;
    context_text?: string;
    request_meta?: WritebackRequestMeta;
  }) =>
    request<WritebackCommitResponseData>('/api/writeback/commit', { method: 'POST', body: JSON.stringify(data) }),

  // Agent runtime context (for custom direct runtime)
  getAgentRuntimeContext: (role?: string, sessionId?: string) =>
    request<AgentRuntimeContextResponse>(
      `/api/agent/runtime-context${role || sessionId ? `?${[
        role ? `role=${encodeURIComponent(role)}` : '',
        sessionId ? `session_id=${encodeURIComponent(sessionId)}` : '',
      ].filter(Boolean).join('&')}` : ''}`
    ),
};
