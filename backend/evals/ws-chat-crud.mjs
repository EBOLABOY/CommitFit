import WebSocket from 'ws';

const BASE_URL = (process.env.BASE_URL || 'https://api-lite.izlx.de5.net').replace(/\/+$/, '');
const EMAIL = process.env.E2E_EMAIL || 'e2e_plan_20260227152700@example.com';
const PASSWORD = process.env.E2E_PASSWORD || 'Aa12345678!';
const AGENT_NAMESPACE = process.env.AGENT_NAMESPACE || 'supervisor-agent';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);

const WRITEBACK_TOOL_NAMES = new Set([
  'user_patch',
  'profile_patch',
  'conditions_upsert',
  'conditions_replace_all',
  'conditions_delete',
  'conditions_clear_all',
  'training_goals_upsert',
  'training_goals_replace_all',
  'training_goals_delete',
  'training_goals_clear_all',
  'health_metrics_create',
  'health_metrics_update',
  'health_metrics_delete',
  'training_plan_set',
  'training_plan_delete',
  'nutrition_plan_set',
  'nutrition_plan_delete',
  'supplement_plan_set',
  'supplement_plan_delete',
  'diet_records_create',
  'diet_records_delete',
  'daily_log_upsert',
  'daily_log_delete',
]);

function toWsBaseUrl(httpBaseUrl) {
  if (httpBaseUrl.startsWith('https://')) return httpBaseUrl.replace(/^https:\/\//, 'wss://');
  if (httpBaseUrl.startsWith('http://')) return httpBaseUrl.replace(/^http:\/\//, 'ws://');
  return httpBaseUrl;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseStreamChunkBody(body) {
  if (ensureObject(body)) return body;
  if (typeof body !== 'string' || body.length === 0) return null;

  const direct = parseJsonSafely(body);
  if (ensureObject(direct)) return direct;

  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const parsed = parseJsonSafely(payload);
    if (ensureObject(parsed)) return parsed;
  }
  return null;
}

function extractErrorText(payload) {
  if (!ensureObject(payload)) return '未知错误';
  if (typeof payload.errorText === 'string' && payload.errorText.trim()) return payload.errorText;
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  if (typeof payload.body === 'string' && payload.body.trim()) return payload.body;
  return '未知错误';
}

function extractJsonObjectFromText(rawText) {
  const text = (rawText || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = parseJsonSafely(fenced[1].trim());
    if (ensureObject(parsed)) return parsed;
  }

  const direct = parseJsonSafely(text);
  if (ensureObject(direct)) return direct;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const maybe = text.slice(start, end + 1);
    const parsed = parseJsonSafely(maybe);
    if (ensureObject(parsed)) return parsed;
  }

  return null;
}

function utcDateOffset(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function apiRequest(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const parsed = text ? parseJsonSafely(text) : null;
  return { response, json: parsed, text };
}

async function login() {
  const { response, json, text } = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });

  if (!response.ok || !json?.success || !json?.data?.token || !json?.data?.user?.id) {
    throw new Error(`登录失败: ${response.status} ${text}`);
  }

  return {
    token: json.data.token,
    userId: json.data.user.id,
  };
}

async function getTrainingPlans(token, limit = 50) {
  const { response, json, text } = await apiRequest(`/api/training?limit=${limit}`, { token });
  if (!response.ok || !json?.success || !Array.isArray(json?.data)) {
    throw new Error(`读取训练计划失败: ${response.status} ${text}`);
  }
  return json.data;
}

async function getNutritionPlans(token, limit = 50) {
  const { response, json, text } = await apiRequest(`/api/nutrition?limit=${limit}`, { token });
  if (!response.ok || !json?.success || !Array.isArray(json?.data)) {
    throw new Error(`读取饮食方案失败: ${response.status} ${text}`);
  }
  return json.data;
}

async function commitWritebackDraft(token, draft) {
  const payload = {
    draft_id: draft.draft_id,
    payload: draft.payload,
    context_text: typeof draft.context_text === 'string' ? draft.context_text : '',
    request_meta: ensureObject(draft.request_meta) ? draft.request_meta : undefined,
  };

  for (let i = 0; i < 25; i += 1) {
    const { response, json, text } = await apiRequest('/api/writeback/commit', {
      method: 'POST',
      token,
      body: payload,
    });

    const state = json?.data?.state;
    if (response.status === 202 || state === 'pending_remote') {
      await sleep(1000);
      continue;
    }

    if (!response.ok || !json?.success) {
      throw new Error(`writeback/commit 失败: ${response.status} ${text}`);
    }

    return json.data;
  }

  throw new Error(`writeback/commit 超时: draft_id=${draft.draft_id}`);
}

class WsAgentClient {
  constructor({ token, userId, sessionId }) {
    this.token = token;
    this.userId = userId;
    this.sessionId = sessionId;
    this.ws = null;
    this.ready = false;
    this.pendingTurn = null;
  }

  async connect() {
    if (this.ws && this.ready) return;

    const wsUrl = `${toWsBaseUrl(BASE_URL)}/agents/${AGENT_NAMESPACE}/${encodeURIComponent(this.userId)}?token=${encodeURIComponent(this.token)}&sid=${encodeURIComponent(this.sessionId)}`;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.ready = true;
        resolve();
      });

      ws.on('error', (error) => {
        if (!this.ready) {
          reject(error);
          return;
        }
        if (this.pendingTurn) {
          const turn = this.pendingTurn;
          this.pendingTurn = null;
          turn.reject(error);
        }
      });

      ws.on('close', () => {
        this.ready = false;
        if (this.pendingTurn) {
          const turn = this.pendingTurn;
          this.pendingTurn = null;
          turn.reject(new Error('WebSocket 已关闭'));
        }
      });

      ws.on('message', async (raw) => {
        try {
          await this.handleMessage(raw.toString());
        } catch (error) {
          if (this.pendingTurn) {
            const turn = this.pendingTurn;
            this.pendingTurn = null;
            turn.reject(error);
          }
        }
      });
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.ready = false;
  }

  async sendUserMessage(text, options = {}) {
    if (!this.ready || !this.ws) {
      throw new Error('WebSocket 未连接');
    }
    if (this.pendingTurn) {
      throw new Error('存在未完成的会话轮次');
    }

    const turn = this.createTurn();
    this.pendingTurn = turn;

    const now = Date.now();
    const userMessageId = `u-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = `req-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const nowDate = new Date();
    const requestMeta = {
      client_request_at: nowDate.toISOString(),
      client_local_date: `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`,
      client_utc_offset_minutes: -nowDate.getTimezoneOffset(),
      client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
    };

    const payload = {
      type: 'cf_agent_use_chat_request',
      id: requestId,
      init: {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: userMessageId,
              role: 'user',
              parts: [{ type: 'text', text }],
            },
          ],
          allow_profile_sync: options.allowProfileSync ?? true,
          execution_profile: options.executionProfile ?? 'build',
          client_trace_id: `ws-crud-${now}`,
          session_id: this.sessionId,
          ...requestMeta,
        }),
      },
    };

    const timeout = setTimeout(() => {
      if (this.pendingTurn === turn) {
        this.pendingTurn = null;
        turn.reject(new Error(`会话超时 (${REQUEST_TIMEOUT_MS}ms)`));
      }
    }, REQUEST_TIMEOUT_MS);

    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      clearTimeout(timeout);
      this.pendingTurn = null;
      throw error;
    }

    try {
      const result = await turn.promise;
      clearTimeout(timeout);
      return result;
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  }

  createTurn() {
    const state = {
      text: '',
      toolInputByCallId: new Map(),
      toolsCalled: new Set(),
      writebackCommits: [],
      commitPromises: [],
      errors: [],
      resolve: null,
      reject: null,
      promise: null,
    };

    state.promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    return state;
  }

  async handleMessage(rawData) {
    const parsed = parseJsonSafely(rawData);
    if (!ensureObject(parsed)) return;

    const msgType = parsed.type;
    if (msgType === 'cf_agent_stream_resuming') {
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      if (id && this.ws && this.ready) {
        this.ws.send(JSON.stringify({ type: 'cf_agent_stream_resume_ack', id }));
      }
      return;
    }

    const turn = this.pendingTurn;
    if (!turn) return;

    if (msgType === 'error') {
      this.pendingTurn = null;
      turn.reject(new Error(extractErrorText(parsed)));
      return;
    }

    if (msgType !== 'cf_agent_use_chat_response') return;

    if (parsed.error === true) {
      this.pendingTurn = null;
      turn.reject(new Error(extractErrorText(parsed)));
      return;
    }

    if (parsed.done === true) {
      this.pendingTurn = null;
      await Promise.all(turn.commitPromises);
      turn.resolve({
        assistantText: turn.text.trim(),
        toolsCalled: Array.from(turn.toolsCalled.values()),
        writebackCommits: turn.writebackCommits,
        errors: turn.errors.slice(),
      });
      return;
    }

    const chunk = parseStreamChunkBody(parsed.body);
    if (!chunk) return;
    const chunkType = chunk.type;

    if (chunkType === 'text-delta') {
      const delta = typeof chunk.delta === 'string' ? chunk.delta : (typeof chunk.text === 'string' ? chunk.text : '');
      if (delta) turn.text += delta;
      return;
    }

    if (chunkType === 'tool-input-available' || chunkType === 'tool-input-error') {
      const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
      const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : '';
      if (toolCallId && toolName) {
        turn.toolInputByCallId.set(toolCallId, toolName);
        turn.toolsCalled.add(toolName);
      }
      return;
    }

    if (chunkType === 'tool-output-available') {
      const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
      const toolNameByCall = toolCallId ? turn.toolInputByCallId.get(toolCallId) : '';
      const toolName = toolNameByCall || (typeof chunk.toolName === 'string' ? chunk.toolName : '');
      if (toolName) turn.toolsCalled.add(toolName);

      const preliminary = chunk.preliminary === true;
      const output = ensureObject(chunk.output) ? chunk.output : null;

      if (!preliminary && toolName && WRITEBACK_TOOL_NAMES.has(toolName) && output) {
        if (output.success === false) {
          turn.errors.push(`写回草稿生成失败(${toolName}): ${extractErrorText(output)}`);
        } else if (typeof output.draft_id === 'string' && output.draft_id.trim() && ensureObject(output.payload)) {
          const draft = {
            draft_id: output.draft_id.trim(),
            payload: output.payload,
            context_text: typeof output.context_text === 'string' ? output.context_text : '',
            request_meta: ensureObject(output.request_meta) ? output.request_meta : undefined,
          };
          const promise = commitWritebackDraft(this.token, draft)
            .then((data) => {
              turn.writebackCommits.push({
                toolName,
                draftId: draft.draft_id,
                state: data?.state || data?.status || 'success',
              });
            })
            .catch((error) => {
              turn.errors.push(`写回提交失败(${toolName}): ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            });
          turn.commitPromises.push(promise);
        }
      }

      if (!preliminary && toolCallId) {
        turn.toolInputByCallId.delete(toolCallId);
      }
      return;
    }

    if (chunkType === 'error') {
      const err = extractErrorText(chunk);
      turn.errors.push(`流式错误: ${err}`);
    }
  }
}

function findTrainingByDate(plans, date) {
  return plans.find((item) => item?.plan_date === date) || null;
}

function findNutritionByDate(plans, date) {
  return plans.find((item) => item?.plan_date === date && typeof item?.content === 'string' && !item.content.startsWith('【补剂方案】')) || null;
}

function evaluateQuery(result, expectedDate, expectedKeyword) {
  const usedQueryTool = result.toolsCalled.includes('query_user_data');
  const jsonObj = extractJsonObjectFromText(result.assistantText);
  const strictOk = Boolean(
    jsonObj &&
    jsonObj.found === true &&
    typeof jsonObj.plan_date === 'string' &&
    jsonObj.plan_date.includes(expectedDate) &&
    typeof jsonObj.content === 'string' &&
    jsonObj.content.includes(expectedKeyword)
  );
  return {
    usedQueryTool,
    strictOk,
    jsonObj,
  };
}

function includesAll(text, keywords) {
  const source = String(text || '');
  return keywords.every((keyword) => source.includes(keyword));
}

async function runCrudFlow() {
  const { token, userId } = await login();
  const sessionId = `ws-crud-${Date.now()}`;
  const client = new WsAgentClient({ token, userId, sessionId });
  await client.connect();

  const tag = Date.now().toString(36).slice(-6);
  const trainingDate = utcDateOffset(2);
  const nutritionDate = utcDateOffset(3);
  const trainingA = `[E2E-${tag}] 训练计划A：深蹲5x5，卧推5x5，跑步20分钟，拉伸10分钟。`;
  const trainingB = `[E2E-${tag}] 训练计划B：硬拉5x3，引体向上4x8，慢跑30分钟，核心训练15分钟。`;
  const nutritionA = `[E2E-${tag}] 饮食方案A：早餐燕麦鸡蛋，午餐鸡胸米饭，晚餐鱼肉蔬菜。`;
  const nutritionB = `[E2E-${tag}] 饮食方案B：早餐全麦面包牛奶，午餐牛肉土豆，晚餐豆腐虾仁。`;

  const result = {
    meta: { userId, sessionId, trainingDate, nutritionDate, tag },
    training: { add: false, query: false, update: false, delete: false, details: {} },
    nutrition: { add: false, query: false, update: false, delete: false, details: {} },
  };

  try {
    const tAdd = await client.sendUserMessage(`请把我在${trainingDate}的训练计划设置为：${trainingA}。这是明确写入请求，请直接执行写回工具并完成。`);
    const trainingAfterAdd = await getTrainingPlans(token, 80);
    const trainingRowAfterAdd = findTrainingByDate(trainingAfterAdd, trainingDate);
    result.training.add = tAdd.toolsCalled.includes('training_plan_set')
      && tAdd.writebackCommits.some((c) => c.toolName === 'training_plan_set')
      && Boolean(trainingRowAfterAdd && includesAll(trainingRowAfterAdd.content, [`[E2E-${tag}]`, '训练计划A']));
    result.training.details.add = {
      tools: tAdd.toolsCalled,
      commits: tAdd.writebackCommits,
      errors: tAdd.errors,
      row: trainingRowAfterAdd,
    };

    const tQuery = await client.sendUserMessage(
      `请查询我在${trainingDate}的训练计划。先调用 query_user_data 工具，然后仅返回一行 JSON：{"found":true/false,"plan_date":"YYYY-MM-DD","content":"..."}。不要输出其他文字。`
    );
    const tQueryEval = evaluateQuery(tQuery, trainingDate, `[E2E-${tag}]`);
    const trainingAfterQuery = await getTrainingPlans(token, 80);
    const trainingRowAfterQuery = findTrainingByDate(trainingAfterQuery, trainingDate);
    result.training.query = Boolean(trainingRowAfterQuery)
      && (tQueryEval.usedQueryTool || tQueryEval.strictOk);
    result.training.details.query = {
      tools: tQuery.toolsCalled,
      strict_json_ok: tQueryEval.strictOk,
      used_query_tool: tQueryEval.usedQueryTool,
      json: tQueryEval.jsonObj,
      assistant_text: tQuery.assistantText,
      row: trainingRowAfterQuery,
    };

    const tUpdate = await client.sendUserMessage(`请把我在${trainingDate}的训练计划更新为：${trainingB}。这是覆盖更新，不需要二次确认。`);
    const trainingAfterUpdate = await getTrainingPlans(token, 80);
    const trainingRowAfterUpdate = findTrainingByDate(trainingAfterUpdate, trainingDate);
    const trainingContentAfterUpdate = String(trainingRowAfterUpdate?.content || '');
    result.training.update = tUpdate.toolsCalled.includes('training_plan_set')
      && tUpdate.writebackCommits.some((c) => c.toolName === 'training_plan_set')
      && includesAll(trainingContentAfterUpdate, [`[E2E-${tag}]`, '训练计划B'])
      && !trainingContentAfterUpdate.includes('训练计划A');
    result.training.details.update = {
      tools: tUpdate.toolsCalled,
      commits: tUpdate.writebackCommits,
      errors: tUpdate.errors,
      row: trainingRowAfterUpdate,
    };

    const tDelete = await client.sendUserMessage(`我确认删除我在${trainingDate}的训练计划，不需要再次确认，请立即执行删除。`);
    const trainingAfterDelete = await getTrainingPlans(token, 80);
    const trainingRowAfterDelete = findTrainingByDate(trainingAfterDelete, trainingDate);
    result.training.delete = tDelete.toolsCalled.includes('training_plan_delete')
      && tDelete.writebackCommits.some((c) => c.toolName === 'training_plan_delete')
      && !trainingRowAfterDelete;
    result.training.details.delete = {
      tools: tDelete.toolsCalled,
      commits: tDelete.writebackCommits,
      errors: tDelete.errors,
      row: trainingRowAfterDelete,
    };

    const nAdd = await client.sendUserMessage(`请把我在${nutritionDate}的饮食方案设置为：${nutritionA}。这是明确写入请求，请直接执行写回工具并完成。`);
    const nutritionAfterAdd = await getNutritionPlans(token, 80);
    const nutritionRowAfterAdd = findNutritionByDate(nutritionAfterAdd, nutritionDate);
    result.nutrition.add = nAdd.toolsCalled.includes('nutrition_plan_set')
      && nAdd.writebackCommits.some((c) => c.toolName === 'nutrition_plan_set')
      && Boolean(nutritionRowAfterAdd && includesAll(nutritionRowAfterAdd.content, [`[E2E-${tag}]`, '饮食方案A']));
    result.nutrition.details.add = {
      tools: nAdd.toolsCalled,
      commits: nAdd.writebackCommits,
      errors: nAdd.errors,
      row: nutritionRowAfterAdd,
    };

    const nQuery = await client.sendUserMessage(
      `请查询我在${nutritionDate}的饮食方案。先调用 query_user_data 工具，然后仅返回一行 JSON：{"found":true/false,"plan_date":"YYYY-MM-DD","content":"..."}。不要输出其他文字。`
    );
    const nQueryEval = evaluateQuery(nQuery, nutritionDate, `[E2E-${tag}]`);
    const nutritionAfterQuery = await getNutritionPlans(token, 80);
    const nutritionRowAfterQuery = findNutritionByDate(nutritionAfterQuery, nutritionDate);
    result.nutrition.query = Boolean(nutritionRowAfterQuery)
      && (nQueryEval.usedQueryTool || nQueryEval.strictOk);
    result.nutrition.details.query = {
      tools: nQuery.toolsCalled,
      strict_json_ok: nQueryEval.strictOk,
      used_query_tool: nQueryEval.usedQueryTool,
      json: nQueryEval.jsonObj,
      assistant_text: nQuery.assistantText,
      row: nutritionRowAfterQuery,
    };

    const nUpdate = await client.sendUserMessage(`请把我在${nutritionDate}的饮食方案更新为：${nutritionB}。这是覆盖更新，不需要二次确认。`);
    const nutritionAfterUpdate = await getNutritionPlans(token, 80);
    const nutritionRowAfterUpdate = findNutritionByDate(nutritionAfterUpdate, nutritionDate);
    const nutritionContentAfterUpdate = String(nutritionRowAfterUpdate?.content || '');
    result.nutrition.update = nUpdate.toolsCalled.includes('nutrition_plan_set')
      && nUpdate.writebackCommits.some((c) => c.toolName === 'nutrition_plan_set')
      && includesAll(nutritionContentAfterUpdate, [`[E2E-${tag}]`, '饮食方案B'])
      && !nutritionContentAfterUpdate.includes('饮食方案A');
    result.nutrition.details.update = {
      tools: nUpdate.toolsCalled,
      commits: nUpdate.writebackCommits,
      errors: nUpdate.errors,
      row: nutritionRowAfterUpdate,
    };

    const nDelete = await client.sendUserMessage(`我确认删除我在${nutritionDate}的饮食方案，不需要再次确认，请立即执行删除。`);
    const nutritionAfterDelete = await getNutritionPlans(token, 80);
    const nutritionRowAfterDelete = findNutritionByDate(nutritionAfterDelete, nutritionDate);
    result.nutrition.delete = nDelete.toolsCalled.includes('nutrition_plan_delete')
      && nDelete.writebackCommits.some((c) => c.toolName === 'nutrition_plan_delete')
      && !nutritionRowAfterDelete;
    result.nutrition.details.delete = {
      tools: nDelete.toolsCalled,
      commits: nDelete.writebackCommits,
      errors: nDelete.errors,
      row: nutritionRowAfterDelete,
    };
  } finally {
    client.close();
  }

  const trainingAllPass = result.training.add && result.training.query && result.training.update && result.training.delete;
  const nutritionAllPass = result.nutrition.add && result.nutrition.query && result.nutrition.update && result.nutrition.delete;
  const allPass = trainingAllPass && nutritionAllPass;

  console.log('=== WS Chat CRUD Check ===');
  console.log(JSON.stringify({
    base_url: BASE_URL,
    namespace: AGENT_NAMESPACE,
    user_id: result.meta.userId,
    session_id: result.meta.sessionId,
    training_date: result.meta.trainingDate,
    nutrition_date: result.meta.nutritionDate,
    training: {
      add: result.training.add,
      query: result.training.query,
      update: result.training.update,
      delete: result.training.delete,
    },
    nutrition: {
      add: result.nutrition.add,
      query: result.nutrition.query,
      update: result.nutrition.update,
      delete: result.nutrition.delete,
    },
    pass: allPass,
  }, null, 2));

  if (!allPass) {
    console.log('\n--- Details (for failures) ---');
    if (!trainingAllPass) {
      console.log(JSON.stringify({ training: result.training.details }, null, 2));
    }
    if (!nutritionAllPass) {
      console.log(JSON.stringify({ nutrition: result.nutrition.details }, null, 2));
    }
    process.exitCode = 1;
  }
}

runCrudFlow().catch((error) => {
  console.error('ws-chat-crud 执行失败:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
