import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { callLLMNonStream } from '../services/llm';
import { getUserContext, buildContextForRole } from '../services/context';
import { NUTRITIONIST_SYSTEM_PROMPT } from '../prompts/nutritionist';
import { isPlainObject, isEnumValue, isNonEmptyString } from '../utils/validate';

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const FOOD_ANALYSIS_PROMPT = `分析以下食物的营养成分。严格按JSON输出，无额外文字：
{"foods":[{"name":"食物名","amount":"份量","calories":数字,"protein":数字,"fat":数字,"carbs":数字}],"total":{"calories":数字,"protein":数字,"fat":数字,"carbs":数字}}

其中 calories 单位为 kcal，protein/fat/carbs 单位为 g。请根据常见中国食物份量合理估算。`;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, Math.min(i + 8192, bytes.length));
    chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  return btoa(chunks.join(''));
}

export const dietRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

dietRoutes.use('*', authMiddleware);

// POST /api/diet/analyze — AI 分析食物营养
dietRoutes.post('/analyze', async (c) => {
  const userId = c.get('userId');
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(payload)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const description = typeof payload.description === 'string' ? payload.description.trim() : '';
  const inlineImage = typeof payload.image === 'string' ? payload.image : '';
  const imageKey = typeof payload.image_key === 'string' ? payload.image_key : '';

  if (!description && !inlineImage && !imageKey) {
    return c.json({ success: false, error: '请提供食物描述或图片' }, 400);
  }

  // Build user context for better analysis
  const userContext = await getUserContext(c.env.DB, userId);
  const contextStr = buildContextForRole('nutritionist', userContext);
  const systemPrompt = NUTRITIONIST_SYSTEM_PROMPT + '\n\n' + contextStr;

  // Build user message content
  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

  const userText = description
    ? `${FOOD_ANALYSIS_PROMPT}\n\n用户描述的食物：${description}`
    : `${FOOD_ANALYSIS_PROMPT}\n\n请分析图片中的食物。`;

  let userContent: string | ContentPart[] = userText;

  // Handle image
  let imageDataUri: string | null = null;
  if (inlineImage && inlineImage.startsWith('data:image/')) {
    imageDataUri = inlineImage;
  } else if (imageKey) {
    try {
      const object = await c.env.R2.get(imageKey);
      if (object) {
        const arrayBuffer = await object.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        const mimeType = object.httpMetadata?.contentType || 'image/jpeg';
        imageDataUri = `data:${mimeType};base64,${base64}`;
      }
    } catch {
      // continue without image
    }
  }

  if (imageDataUri) {
    userContent = [
      { type: 'image_url', image_url: { url: imageDataUri } },
      { type: 'text', text: userText },
    ];
  }

  try {
    const response = await callLLMNonStream({
      env: c.env,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return c.json({ success: false, error: 'AI 未返回有效的营养分析结果' }, 502);
    }

    const analysisResult = JSON.parse(jsonMatch[0]);
    return c.json({ success: true, data: analysisResult });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'AI 分析失败';
    return c.json({ success: false, error: errMsg }, 502);
  }
});

// GET /api/diet?date=YYYY-MM-DD — 获取某日饮食记录
dietRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const date = c.req.query('date');

  let query: string;
  let params: unknown[];

  if (date && DATE_REGEX.test(date)) {
    query = 'SELECT * FROM diet_records WHERE user_id = ? AND record_date = ? ORDER BY created_at ASC';
    params = [userId, date];
  } else {
    query = 'SELECT * FROM diet_records WHERE user_id = ? ORDER BY record_date DESC, created_at ASC LIMIT 30';
    params = [userId];
  }

  const { results } = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ success: true, data: results });
});

// POST /api/diet — 保存饮食记录
dietRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ success: false, error: '请求体必须为 JSON' }, 400);
  }

  if (!isPlainObject(payload)) {
    return c.json({ success: false, error: '请求体格式错误' }, 400);
  }

  const mealType = payload.meal_type;
  const recordDate = payload.record_date;
  const foodDescription = payload.food_description;

  if (!isEnumValue(mealType, VALID_MEAL_TYPES)) {
    return c.json({ success: false, error: '无效的餐次类型' }, 400);
  }
  if (typeof recordDate !== 'string' || !DATE_REGEX.test(recordDate)) {
    return c.json({ success: false, error: '日期格式应为 YYYY-MM-DD' }, 400);
  }
  if (!isNonEmptyString(foodDescription)) {
    return c.json({ success: false, error: '食物描述不能为空' }, 400);
  }

  const id = crypto.randomUUID();
  const foodsJson = typeof payload.foods_json === 'string' ? payload.foods_json : null;
  const calories = typeof payload.calories === 'number' ? payload.calories : null;
  const protein = typeof payload.protein === 'number' ? payload.protein : null;
  const fat = typeof payload.fat === 'number' ? payload.fat : null;
  const carbs = typeof payload.carbs === 'number' ? payload.carbs : null;
  const imageKey = typeof payload.image_key === 'string' ? payload.image_key : null;

  await c.env.DB.prepare(
    'INSERT INTO diet_records (id, user_id, meal_type, record_date, food_description, foods_json, calories, protein, fat, carbs, image_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, mealType, recordDate, foodDescription.trim(), foodsJson, calories, protein, fat, carbs, imageKey)
    .run();

  return c.json({ success: true, data: { id } });
});

// DELETE /api/diet/:id — 删除饮食记录
dietRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const recordId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM diet_records WHERE id = ? AND user_id = ?'
  )
    .bind(recordId, userId)
    .first();

  if (!existing) {
    return c.json({ success: false, error: '记录不存在' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM diet_records WHERE id = ? AND user_id = ?')
    .bind(recordId, userId)
    .run();

  return c.json({ success: true });
});
