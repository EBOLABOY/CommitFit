import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../constants';
import type {
  UpdateProfileRequest,
  CreateHealthMetricRequest,
  CreateConditionRequest,
  CreateTrainingGoalRequest,
  CreateDietRecordRequest,
  UpsertDailyLogRequest,
  OrchestrateChatRequest,
  OrchestrateChatResponse,
  OrchestrateAutoWriteSummary,
  SSERoutingEvent,
  SSESupplementEvent,
  WritebackAudit,
} from '../../shared/types';

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

  // AI Chat
  getChatHistory: (role: string) => request(`/api/ai/history?role=${role}`),
  clearChatHistory: (role: string) =>
    request(`/api/ai/history?role=${role}`, { method: 'DELETE' }),
  orchestrateChat: (data: OrchestrateChatRequest) =>
    request<OrchestrateChatResponse>('/api/ai/orchestrate', { method: 'POST', body: JSON.stringify(data) }),
  getOrchestrateHistory: () =>
    request<{ messages: Array<{ id: string; message_role: 'user' | 'assistant'; content: string; image_url?: string | null; metadata?: string | null; created_at: string }> }>(
      '/api/ai/orchestrate/history'
    ),
  getOrchestrateWritebackAudits: (limit = 20) =>
    request<{ audits: WritebackAudit[] }>(`/api/ai/orchestrate/writeback-audits?limit=${limit}`),
  clearOrchestrateHistory: () =>
    request('/api/ai/orchestrate/history', { method: 'DELETE' }),

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
};

// ---------------------------------------------------------------------------
// XHR-based SSE streaming for React Native
// ---------------------------------------------------------------------------
// React Native's default fetch (whatwg-fetch polyfill) does NOT expose
// response.body as a ReadableStream, so parseSSEStream's fallback waits for
// the entire response via response.text() — no incremental streaming at all.
//
// XMLHttpRequest in React Native fires onreadystatechange with readyState 3
// (LOADING) as data arrives, giving us access to the partial responseText.
// This lets us parse SSE events incrementally and deliver real-time streaming.
// ---------------------------------------------------------------------------

function streamSSEViaXHR(
  url: string,
  headers: Record<string, string>,
  body: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStatus?: (message: string) => void,
  onWriteback?: (summary: OrchestrateAutoWriteSummary) => void,
  onWritebackError?: (message: string) => void,
  onRouting?: (routing: SSERoutingEvent) => void,
  onSupplement?: (supplement: SSESupplementEvent) => void,
): void {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);

  for (const [key, value] of Object.entries(headers)) {
    xhr.setRequestHeader(key, value);
  }

  let lastIndex = 0;
  let buffer = '';
  let errorFired = false;

  const processIncoming = (isFinal: boolean) => {
    if (errorFired) return;

    try {
      const full = xhr.responseText;
      const newText = full.substring(lastIndex);
      lastIndex = full.length;

      if (!newText && !isFinal) return;

      buffer += newText.replace(/\r\n/g, '\n');

      let splitIndex = buffer.indexOf('\n\n');
      while (splitIndex !== -1) {
        const block = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        if (block.trim()) {
          consumeSSEEventBlock(block, onChunk, onStatus, onWriteback, onWritebackError, onRouting, onSupplement);
        }
        splitIndex = buffer.indexOf('\n\n');
      }

      if (isFinal && buffer.trim()) {
        consumeSSEEventBlock(buffer, onChunk, onStatus, onWriteback, onWritebackError, onRouting, onSupplement);
        buffer = '';
      }
    } catch (error) {
      errorFired = true;
      onError(error instanceof Error ? error : new Error('解析响应失败'));
    }
  };

  xhr.onreadystatechange = () => {
    if (errorFired) return;

    if (xhr.readyState === 3) {
      // LOADING — partial responseText available
      if (xhr.status >= 200 && xhr.status < 300) {
        processIncoming(false);
      }
    } else if (xhr.readyState === 4) {
      // DONE
      if (xhr.status >= 200 && xhr.status < 300) {
        processIncoming(true);
        if (!errorFired) onDone();
      } else {
        let errorMsg = `请求失败 (${xhr.status})`;
        try {
          const errData = JSON.parse(xhr.responseText);
          if (typeof errData.error === 'string') errorMsg = errData.error;
          else if (typeof errData.message === 'string') errorMsg = errData.message;
        } catch {
          // use default error message
        }
        onError(new Error(errorMsg));
      }
    }
  };

  xhr.onerror = () => {
    if (!errorFired) {
      errorFired = true;
      onError(new Error('网络连接失败'));
    }
  };

  xhr.ontimeout = () => {
    if (!errorFired) {
      errorFired = true;
      onError(new Error('请求超时'));
    }
  };

  xhr.timeout = 120000;
  xhr.send(body);
}

// Streaming chat - SSE event block parser
function consumeSSEEventBlock(
  block: string,
  onChunk: (text: string) => void,
  onStatus?: (message: string) => void,
  onWriteback?: (summary: OrchestrateAutoWriteSummary) => void,
  onWritebackError?: (message: string) => void,
  onRouting?: (routing: SSERoutingEvent) => void,
  onSupplement?: (supplement: SSESupplementEvent) => void,
): void {
  let eventType = 'message';
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;

    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return;

  if (eventType === 'status') {
    if (!onStatus) return;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const message =
        typeof parsed.message === 'string'
          ? parsed.message
          : payload;
      onStatus(message);
    } catch {
      onStatus(payload);
    }
    return;
  }

  if (eventType === 'writeback') {
    if (!onWriteback) return;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const summary: OrchestrateAutoWriteSummary = {
        profile_updated: parsed.profile_updated === true,
        conditions_upserted: typeof parsed.conditions_upserted === 'number' ? parsed.conditions_upserted : 0,
        training_goals_upserted: typeof parsed.training_goals_upserted === 'number' ? parsed.training_goals_upserted : 0,
        health_metrics_created: typeof parsed.health_metrics_created === 'number' ? parsed.health_metrics_created : 0,
        nutrition_plan_created: parsed.nutrition_plan_created === true,
        supplement_plan_created: parsed.supplement_plan_created === true,
        daily_log_upserted: parsed.daily_log_upserted === true,
      };
      onWriteback(summary);
    } catch {
      // ignore malformed writeback payload
    }
    return;
  }

  if (eventType === 'writeback_error') {
    if (!onWritebackError) return;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const errorMessage =
        typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.message === 'string'
            ? parsed.message
            : payload || '写回失败';
      onWritebackError(errorMessage);
    } catch {
      onWritebackError(payload || '写回失败');
    }
    return;
  }

  if (eventType === 'routing') {
    if (!onRouting) return;
    try {
      const parsed = JSON.parse(payload) as SSERoutingEvent;
      onRouting(parsed);
    } catch {
      // ignore malformed routing payload
    }
    return;
  }

  if (eventType === 'supplement') {
    if (!onSupplement) return;
    try {
      const parsed = JSON.parse(payload) as SSESupplementEvent;
      onSupplement(parsed);
    } catch {
      // ignore malformed supplement payload
    }
    return;
  }

  if (eventType === 'done') {
    // Stream end signal — no action needed, onDone will fire via XHR readyState 4
    return;
  }

  if (eventType === 'error') {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const errorText =
        typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.message === 'string'
            ? parsed.message
            : 'AI 服务异常';
      throw new Error(errorText);
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error(payload || 'AI 服务异常');
    }
  }

  try {
    const parsed = JSON.parse(payload);
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) onChunk(content);
  } catch {
    // ignore malformed message chunk
  }
}

export async function streamChat(
  role: string,
  message: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  imageOption?: { inline: string } | { key: string }
): Promise<void> {
  try {
    const token = await getToken();

    const body: Record<string, string> = { role, message };
    if (imageOption) {
      if ('inline' in imageOption) body.image = imageOption.inline;
      else body.image_key = imageOption.key;
    }

    streamSSEViaXHR(
      `${API_BASE_URL}/api/ai/chat`,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      JSON.stringify(body),
      onChunk,
      onDone,
      onError,
    );
  } catch (error) {
    onError(error instanceof Error ? error : new Error('未知错误'));
  }
}

export interface OrchestrateStreamCallbacks {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  onStatus?: (message: string) => void;
  onRouting?: (routing: SSERoutingEvent) => void;
  onSupplement?: (supplement: SSESupplementEvent) => void;
  onWriteback?: (summary: OrchestrateAutoWriteSummary) => void;
  onWritebackError?: (message: string) => void;
}

export async function streamOrchestrateChat(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  callbacks: OrchestrateStreamCallbacks,
  imageOption?: { inline: string } | { key: string },
): Promise<void> {
  try {
    const token = await getToken();

    const body: Record<string, unknown> = { message, history, auto_writeback: true };
    if (imageOption) {
      if ('inline' in imageOption) body.image = imageOption.inline;
      else body.image_key = imageOption.key;
    }

    streamSSEViaXHR(
      `${API_BASE_URL}/api/ai/orchestrate/stream`,
      {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      JSON.stringify(body),
      callbacks.onChunk,
      callbacks.onDone,
      callbacks.onError,
      callbacks.onStatus,
      callbacks.onWriteback,
      callbacks.onWritebackError,
      callbacks.onRouting,
      callbacks.onSupplement,
    );
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new Error('未知错误'));
  }
}
