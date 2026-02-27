const BACKEND = (process.env.BACKEND_BASE_URL || 'https://api-lite.izlx.de5.net').replace(/\/+$/, '');
const CUSTOM_BASE = (process.env.CUSTOM_BASE_URL || 'http://154.19.184.12:3000/v1').replace(/\/+$/, '');
const CUSTOM_KEY = (process.env.CUSTOM_API_KEY || '').trim();
const PRIMARY_MODEL = (process.env.CUSTOM_PRIMARY_MODEL || 'LLM').trim();
const FALLBACK_MODEL = (process.env.CUSTOM_FALLBACK_MODEL || PRIMARY_MODEL).trim();
const EMAIL = (process.env.E2E_EMAIL || 'e2e_plan_20260227152700@example.com').trim();
const PASSWORD = (process.env.E2E_PASSWORD || 'Aa12345678!').trim();

if (!CUSTOM_KEY) {
  console.error('缺少 CUSTOM_API_KEY');
  process.exit(1);
}

function uniqueModels() {
  return Array.from(new Set([PRIMARY_MODEL, FALLBACK_MODEL].filter(Boolean)));
}

function jsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function txt(v, d = '') {
  if (typeof v !== 'string') return d;
  const t = v.trim();
  return t || d;
}

function dOffset(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function reqMeta() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    client_request_at: now.toISOString(),
    client_local_date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    client_utc_offset_minutes: -now.getTimezoneOffset(),
    client_timezone: typeof tz === 'string' ? tz : undefined,
  };
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BACKEND}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const raw = await res.text();
  return { res, json: raw ? jsonParse(raw) : null, raw };
}

async function mustApi(pathOrToken, optsOrPath) {
  let path = '';
  let opts = {};
  if (typeof pathOrToken === 'string' && pathOrToken.startsWith('/')) {
    path = pathOrToken;
    opts = isObj(optsOrPath) ? optsOrPath : {};
  } else {
    path = typeof optsOrPath === 'string' ? optsOrPath : '';
    opts = { token: pathOrToken };
  }
  const { res, json, raw } = await api(path, opts);
  if (!res.ok || !json?.success) throw new Error(`${path} 失败: ${res.status} ${raw}`);
  return json.data;
}

async function login() {
  const { res, json, raw } = await api('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  if (!res.ok || !json?.success || !json?.data?.token) throw new Error(`登录失败: ${res.status} ${raw}`);
  return { token: json.data.token, userId: json.data.user.id };
}

async function callModel(body) {
  const errs = [];
  for (const model of uniqueModels()) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await fetch(`${CUSTOM_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CUSTOM_KEY}` },
        body: JSON.stringify({ ...body, model }),
      });
      const raw = await res.text();
      const json = raw ? jsonParse(raw) : null;
      if (res.ok && isObj(json)) return { model, json };
      errs.push(`${model}#${attempt}:${raw || res.status}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw new Error(`模型调用失败: ${errs.join(' | ')}`);
}

const WB = new Set([
  'user_patch', 'profile_patch',
  'conditions_upsert', 'conditions_delete',
  'training_goals_upsert', 'training_goals_delete',
  'health_metrics_create', 'health_metrics_update', 'health_metrics_delete',
  'training_plan_set', 'training_plan_delete',
  'nutrition_plan_set', 'nutrition_plan_delete',
  'supplement_plan_set', 'supplement_plan_delete',
  'diet_records_create', 'diet_records_delete',
  'daily_log_upsert', 'daily_log_delete',
]);

function toPayload(name, args) {
  if (!isObj(args)) return null;
  switch (name) {
    case 'user_patch': return { payload: { user: { nickname: args.nickname, avatar_key: args.avatar_key } }, summary: 'user' };
    case 'profile_patch': return { payload: { profile: { training_goal: args.training_goal } }, summary: 'profile' };
    case 'conditions_upsert': return { payload: { conditions: args.conditions, conditions_mode: 'upsert' }, summary: 'cond add' };
    case 'conditions_delete': return { payload: { conditions_delete_ids: args.ids }, summary: 'cond del' };
    case 'training_goals_upsert': return { payload: { training_goals: args.goals, training_goals_mode: 'upsert' }, summary: 'goal add' };
    case 'training_goals_delete': return { payload: { training_goals_delete_ids: args.ids }, summary: 'goal del' };
    case 'health_metrics_create': return { payload: { health_metrics: args.metrics }, summary: 'metric add' };
    case 'health_metrics_update': return { payload: { health_metrics_update: args.updates }, summary: 'metric upd' };
    case 'health_metrics_delete': return { payload: { health_metrics_delete_ids: args.ids }, summary: 'metric del' };
    case 'training_plan_set': return { payload: { training_plan: { plan_date: args.plan_date, content: args.content } }, summary: 'tp add' };
    case 'training_plan_delete': return { payload: { training_plan_delete_date: args.plan_date }, summary: 'tp del' };
    case 'nutrition_plan_set': return { payload: { nutrition_plan: { plan_date: args.plan_date, content: args.content } }, summary: 'np add' };
    case 'nutrition_plan_delete': return { payload: { nutrition_plan_delete_date: args.plan_date }, summary: 'np del' };
    case 'supplement_plan_set': return { payload: { supplement_plan: { plan_date: args.plan_date, content: args.content } }, summary: 'sp add' };
    case 'supplement_plan_delete': return { payload: { supplement_plan_delete_date: args.plan_date }, summary: 'sp del' };
    case 'diet_records_create': return { payload: { diet_records: args.records }, summary: 'diet add' };
    case 'diet_records_delete': return { payload: { diet_records_delete: args.deletes }, summary: 'diet del' };
    case 'daily_log_upsert': return { payload: { daily_log: { log_date: args.log_date, weight: args.weight, sleep_hours: args.sleep_hours, sleep_quality: args.sleep_quality, note: args.note } }, summary: 'log add' };
    case 'daily_log_delete': return { payload: { daily_log_delete_date: args.log_date }, summary: 'log del' };
    default: return null;
  }
}

async function commit(token, payload, contextText) {
  const draft = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < 20; i += 1) {
    const { res, json, raw } = await api('/api/writeback/commit', {
      method: 'POST',
      token,
      body: { draft_id: draft, payload, context_text: contextText, request_meta: reqMeta() },
    });
    if (res.status === 202 || json?.data?.state === 'pending_remote') {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok || !json?.success) throw new Error(`commit失败: ${res.status} ${raw}`);
    return json.data;
  }
  throw new Error('commit 超时');
}

function tools() {
  return [
    { type: 'function', function: { name: 'query_user_data', description: '查询用户数据', parameters: { type: 'object', properties: { resource: { type: 'string' }, limit: { type: 'number' }, plan_kind: { type: 'string' } }, required: ['resource'] } } },
    { type: 'function', function: { name: 'delegate_generate', description: '委托生成', parameters: { type: 'object', properties: { kind: { type: 'string' }, role: { type: 'string' }, plan_date: { type: 'string' }, request: { type: 'string' } }, required: ['kind', 'request'] } } },
    ...Array.from(WB).map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', additionalProperties: true } } })),
  ];
}

async function runTurn(ctx, prompt) {
  const convo = [
    { role: 'system', content: `${ctx.runtime.system_prompt}\n\n${ctx.runtime.context_text}\n\n执行模式：build\n写回模式：${ctx.runtime.writeback_mode}` },
    { role: 'user', content: prompt },
  ];
  const called = [];
  const out = [];

  for (let step = 0; step < 6; step += 1) {
    const { json } = await callModel({ stream: false, temperature: 0.25, messages: convo, tools: tools(), tool_choice: 'auto' });
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    const msg = isObj(choice?.message) ? choice.message : {};
    const text = (typeof msg.content === 'string' ? msg.content : '').trim();
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    convo.push({ role: 'assistant', content: text || '', tool_calls: toolCalls.length ? toolCalls : undefined });
    if (!toolCalls.length) return { text, called, out };

    for (const tc of toolCalls) {
      const name = txt(tc?.function?.name);
      const args = jsonParse(txt(tc?.function?.arguments, '{}')) || {};
      called.push(name);
      if (name === 'query_user_data') {
        let result = { success: false, error: 'unsupported' };
        if (args.resource === 'training_plans') {
          result = { success: true, data: await mustApi(ctx.token, `/api/training?limit=${Math.max(1, Math.min(50, Number(args.limit) || 20))}`) };
        } else if (args.resource === 'nutrition_plans') {
          result = { success: true, data: await mustApi(ctx.token, `/api/nutrition?limit=${Math.max(1, Math.min(50, Number(args.limit) || 20))}`) };
        }
        out.push({ name, result });
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        continue;
      }
      if (name === 'delegate_generate') {
        const req = [txt(args.request), txt(args.plan_date)].filter(Boolean).join('\n');
        const { json: gJson } = await callModel({ stream: false, temperature: 0.3, messages: [{ role: 'user', content: req || '生成训练计划' }] });
        const gChoice = Array.isArray(gJson.choices) ? gJson.choices[0] : null;
        const gMsg = isObj(gChoice?.message) ? gChoice.message : {};
        const result = { success: true, content: txt(gMsg.content) };
        out.push({ name, result });
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        continue;
      }
      if (WB.has(name)) {
        const mapped = toPayload(name, args);
        if (!mapped) throw new Error(`工具参数无效: ${name}`);
        const result = await commit(ctx.token, mapped.payload, ctx.runtime.context_text || '');
        out.push({ name, result });
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ success: true, state: result.state || result.status || 'success' }) });
        continue;
      }
      convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ success: false, error: 'unknown tool' }) });
    }
  }
  throw new Error('超过最大工具迭代');
}

function ok(assertion, msg) {
  if (!assertion) throw new Error(msg);
}

async function main() {
  const { token, userId } = await login();
  const runtime = await mustApi(token, `/api/agent/runtime-context?role=trainer&session_id=${encodeURIComponent(`direct-${Date.now()}`)}`);
  const ctx = { token, userId, runtime };
  const tag = `E2E-${Date.now().toString(36).slice(-6)}`;
  const d1 = dOffset(2), d2 = dOffset(3), d3 = dOffset(4), dDiet = dOffset(1), dLog = dOffset(1);
  const rep = [];

  async function t(name, fn) {
    try { await fn(); rep.push({ name, pass: true }); }
    catch (e) { rep.push({ name, pass: false, error: e instanceof Error ? e.message : String(e) }); }
  }

  let condId = '', goalId = '', metricId = '';
  let oldNick = null, oldGoal = null;

  await t('chat.basic', async () => {
    const r = await runTurn(ctx, '请直接回复：收到。不要调用任何工具。');
    ok((r.text || '').includes('收到') || r.called.length === 0, '基础对话异常');
  });

  await t('delegate.generate', async () => {
    const r = await runTurn(ctx, `请调用 delegate_generate 工具生成计划，参数 {"kind":"training_plan","request":"为新手生成简短训练计划","plan_date":"${d1}"}`);
    ok(r.called.includes('delegate_generate'), '未调用 delegate_generate');
  });

  await t('training.crud', async () => {
    await runTurn(ctx, `请调用 training_plan_set 工具，参数 {"plan_date":"${d1}","content":"${tag} 训练计划A 深蹲卧推跑步"}。`);
    const a = await mustApi(token, '/api/training?limit=50');
    ok(a.some((x) => x.plan_date === d1 && String(x.content || '').includes(tag)), '训练计划新增失败');
    const q = await runTurn(ctx, '请调用 query_user_data 工具查询 training_plans');
    ok(q.called.includes('query_user_data'), '训练计划查询未调用 query_user_data');
    await runTurn(ctx, `请调用 training_plan_set 工具，参数 {"plan_date":"${d1}","content":"${tag} 训练计划B 硬拉引体核心"}。`);
    const u = await mustApi(token, '/api/training?limit=50');
    ok(u.some((x) => x.plan_date === d1 && String(x.content || '').includes('训练计划B')), '训练计划更新失败');
    await runTurn(ctx, `请调用 training_plan_delete 工具，参数 {"plan_date":"${d1}"}。`);
    const d = await mustApi(token, '/api/training?limit=50');
    ok(!d.some((x) => x.plan_date === d1), '训练计划删除失败');
  });

  await t('nutrition.crud', async () => {
    await runTurn(ctx, `请调用 nutrition_plan_set 工具，参数 {"plan_date":"${d2}","content":"${tag} 饮食方案A 鸡胸米饭蔬菜"}。`);
    const a = await mustApi(token, '/api/nutrition?limit=80');
    ok(a.some((x) => x.plan_date === d2 && !String(x.content || '').startsWith('【补剂方案】') && String(x.content || '').includes(tag)), '饮食方案新增失败');
    const q = await runTurn(ctx, '请调用 query_user_data 工具查询 nutrition_plans');
    ok(q.called.includes('query_user_data'), '饮食方案查询未调用 query_user_data');
    await runTurn(ctx, `请调用 nutrition_plan_set 工具，参数 {"plan_date":"${d2}","content":"${tag} 饮食方案B 牛肉豆腐"}。`);
    const u = await mustApi(token, '/api/nutrition?limit=80');
    ok(u.some((x) => x.plan_date === d2 && String(x.content || '').includes('饮食方案B')), '饮食方案更新失败');
    await runTurn(ctx, `请调用 nutrition_plan_delete 工具，参数 {"plan_date":"${d2}"}。`);
    const d = await mustApi(token, '/api/nutrition?limit=80');
    ok(!d.some((x) => x.plan_date === d2 && !String(x.content || '').startsWith('【补剂方案】')), '饮食方案删除失败');
  });

  await t('supplement.set-delete', async () => {
    await runTurn(ctx, `请调用 supplement_plan_set 工具，参数 {"plan_date":"${d3}","content":"${tag} 补剂方案 肌酸鱼油"}。`);
    const a = await mustApi(token, '/api/nutrition?limit=80');
    ok(a.some((x) => x.plan_date === d3 && String(x.content || '').startsWith('【补剂方案】') && String(x.content || '').includes(tag)), '补剂方案新增失败');
    await runTurn(ctx, `请调用 supplement_plan_delete 工具，参数 {"plan_date":"${d3}"}。`);
    const d = await mustApi(token, '/api/nutrition?limit=80');
    ok(!d.some((x) => x.plan_date === d3 && String(x.content || '').startsWith('【补剂方案】')), '补剂方案删除失败');
  });

  await t('conditions.add-delete', async () => {
    await runTurn(ctx, `请调用 conditions_upsert 工具，参数 {"conditions":[{"name":"${tag}-膝盖","description":"测试","severity":"mild","status":"active"}]}。`);
    const a = await mustApi(token, '/api/conditions?status=all');
    const row = a.find((x) => String(x.name || '').includes(tag));
    ok(Boolean(row), '伤病新增失败');
    condId = String(row.id || '');
    await runTurn(ctx, `请调用 conditions_delete 工具，参数 {"ids":["${condId}"]}。`);
    const d = await mustApi(token, '/api/conditions?status=all');
    ok(!d.some((x) => String(x.id) === condId), '伤病删除失败');
  });

  await t('training-goal.add-delete', async () => {
    await runTurn(ctx, `请调用 training_goals_upsert 工具，参数 {"goals":[{"name":"${tag}-增肌","description":"测试目标","status":"active"}]}。`);
    const a = await mustApi(token, '/api/training-goals?status=all');
    const row = a.find((x) => String(x.name || '').includes(tag));
    ok(Boolean(row), '训练目标新增失败');
    goalId = String(row.id || '');
    await runTurn(ctx, `请调用 training_goals_delete 工具，参数 {"ids":["${goalId}"]}。`);
    const d = await mustApi(token, '/api/training-goals?status=all');
    ok(!d.some((x) => String(x.id) === goalId), '训练目标删除失败');
  });

  await t('health.cud', async () => {
    await runTurn(ctx, `请调用 health_metrics_create 工具，参数 {"metrics":[{"metric_type":"other","value":"{\\"tag\\":\\"${tag}\\",\\"score\\":1}","unit":"u","recorded_at":"${dLog}"}]}。`);
    const a = await mustApi(token, '/api/health');
    const row = a.find((x) => String(x.value || '').includes(tag));
    ok(Boolean(row), '理化指标新增失败');
    metricId = String(row.id || '');
    await runTurn(ctx, `请调用 health_metrics_update 工具，参数 {"updates":[{"id":"${metricId}","value":"{\\"tag\\":\\"${tag}\\",\\"score\\":2}","unit":"u2","recorded_at":"${dLog}"}]}。`);
    const u = await mustApi(token, '/api/health');
    ok(u.some((x) => String(x.id) === metricId && String(x.value || '').includes('"score":2') && String(x.unit || '') === 'u2'), '理化指标更新失败');
    await runTurn(ctx, `请调用 health_metrics_delete 工具，参数 {"ids":["${metricId}"]}。`);
    const d = await mustApi(token, '/api/health');
    ok(!d.some((x) => String(x.id) === metricId), '理化指标删除失败');
  });

  await t('diet.add-delete', async () => {
    await runTurn(ctx, `请调用 diet_records_create 工具，参数 {"records":[{"meal_type":"lunch","record_date":"${dDiet}","food_description":"${tag} 米饭鸡胸","calories":520,"protein":35,"fat":12,"carbs":60}]}。`);
    const a = await mustApi(token, `/api/diet?date=${encodeURIComponent(dDiet)}`);
    ok(a.some((x) => String(x.food_description || '').includes(tag)), '饮食记录新增失败');
    await runTurn(ctx, `请调用 diet_records_delete 工具，参数 {"deletes":[{"meal_type":"lunch","record_date":"${dDiet}"}]}。`);
    const d = await mustApi(token, `/api/diet?date=${encodeURIComponent(dDiet)}`);
    ok(!d.some((x) => String(x.food_description || '').includes(tag)), '饮食记录删除失败');
  });

  await t('daily-log.add-delete', async () => {
    await runTurn(ctx, `请调用 daily_log_upsert 工具，参数 {"log_date":"${dLog}","weight":70.5,"sleep_hours":7,"sleep_quality":"good","note":"${tag} 日志"}。`);
    const a = await mustApi(token, `/api/daily-logs?date=${encodeURIComponent(dLog)}`);
    ok(a && String(a.note || '').includes(tag), '每日日志新增失败');
    await runTurn(ctx, `请调用 daily_log_delete 工具，参数 {"log_date":"${dLog}"}。`);
    const d = await mustApi(token, `/api/daily-logs?date=${encodeURIComponent(dLog)}`);
    ok(!d, '每日日志删除失败');
  });

  await t('user-profile.patch-revert', async () => {
    const me = await mustApi(token, '/api/auth/me');
    const pf = await mustApi(token, '/api/profile');
    oldNick = me?.nickname ?? null;
    oldGoal = pf?.training_goal ?? null;
    const newNick = `${String(oldNick || 'u').slice(0, 8)}_${tag}`.slice(0, 20);
    const newGoal = `${tag} 档案目标`;
    await runTurn(ctx, `请调用 user_patch 工具，参数 {"nickname":"${newNick}"}。`);
    await runTurn(ctx, `请调用 profile_patch 工具，参数 {"training_goal":"${newGoal}"}。`);
    const me2 = await mustApi(token, '/api/auth/me');
    const pf2 = await mustApi(token, '/api/profile');
    ok((me2?.nickname || '') === newNick, 'user_patch 失败');
    ok((pf2?.training_goal || '') === newGoal, 'profile_patch 失败');
    await runTurn(ctx, `请调用 user_patch 工具，参数 {"nickname":${oldNick === null ? 'null' : JSON.stringify(String(oldNick))}}。`);
    if (oldGoal !== null) {
      await runTurn(ctx, `请调用 profile_patch 工具，参数 {"training_goal":${JSON.stringify(String(oldGoal))}}。`);
    }
  });

  const pass = rep.filter((x) => x.pass).length;
  const fail = rep.length - pass;
  console.log(JSON.stringify({
    backend: BACKEND,
    custom_base: CUSTOM_BASE,
    model_primary: PRIMARY_MODEL,
    model_fallback: FALLBACK_MODEL,
    user_id: userId,
    pass,
    fail,
    all_pass: fail === 0,
    report: rep,
  }, null, 2));
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  if (e instanceof Error) {
    console.error('direct-custom-smoke 执行失败:', e.message);
    if (e.stack) console.error(e.stack);
    const cause = e.cause;
    if (cause) console.error('cause:', cause);
  } else {
    console.error('direct-custom-smoke 执行失败:', String(e));
  }
  process.exitCode = 1;
});
