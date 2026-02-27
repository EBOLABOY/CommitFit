import type { D1Database } from '@cloudflare/workers-types';
import { DOCTOR_SYSTEM_PROMPT } from '../prompts/doctor';
import { REHAB_SYSTEM_PROMPT } from '../prompts/rehab';
import { NUTRITIONIST_SYSTEM_PROMPT } from '../prompts/nutritionist';
import { TRAINER_SYSTEM_PROMPT } from '../prompts/trainer';
import { isISODateString } from '../utils/validate';

export type AIRole = 'doctor' | 'rehab' | 'nutritionist' | 'trainer';

export interface OrchestrateAutoWriteSummary {
  profile_updated: boolean;
  user_updated?: boolean;
  conditions_upserted: number;
  conditions_deleted?: number;
  training_goals_upserted: number;
  training_goals_deleted?: number;
  health_metrics_created: number;
  health_metrics_updated?: number;
  health_metrics_deleted?: number;
  training_plan_created: boolean;
  training_plan_deleted?: boolean;
  nutrition_plan_created: boolean;
  nutrition_plan_deleted?: boolean;
  supplement_plan_created: boolean;
  supplement_plan_deleted?: boolean;
  diet_records_created: number;
  diet_records_deleted?: number;
  daily_log_upserted: boolean;
  daily_log_deleted?: boolean;
}

type Gender = 'male' | 'female';
type Severity = 'mild' | 'moderate' | 'severe';
type ConditionStatus = 'active' | 'recovered';
type TrainingGoalStatus = 'active' | 'completed';
type ConditionsWriteMode = 'upsert' | 'replace_all' | 'clear_all';
type TrainingGoalsWriteMode = 'upsert' | 'replace_all' | 'clear_all';
type MetricType = 'testosterone' | 'blood_pressure' | 'blood_lipids' | 'blood_sugar' | 'heart_rate' | 'body_fat' | 'other';
type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
type SleepQuality = 'good' | 'fair' | 'poor';

interface ExtractedProfilePatch {
  height?: number | null;
  weight?: number | null;
  birth_date?: string | null;
  gender?: Gender | null;
  training_goal?: string | null;
  training_start_time?: string | null;
  breakfast_time?: string | null;
  lunch_time?: string | null;
  dinner_time?: string | null;
  training_years?: number | null;
}

interface ExtractedCondition {
  name?: string;
  description?: string | null;
  severity?: Severity | null;
  status?: ConditionStatus | null;
}

interface ExtractedTrainingGoal {
  name?: string;
  description?: string | null;
  status?: TrainingGoalStatus | null;
}

interface ExtractedMetric {
  metric_type?: MetricType;
  value?: unknown;
  unit?: string | null;
  recorded_at?: string | null;
}

interface ExtractedPlan {
  content?: string;
  plan_date?: string;
}

interface ExtractedTrainingPlan {
  content?: string;
  plan_date?: string | null;
  notes?: string | null;
  completed?: boolean | number | null;
}

interface ExtractedDietRecord {
  meal_type?: MealType;
  record_date?: string | null;
  food_description?: string;
  foods_json?: unknown;
  calories?: number | null;
  protein?: number | null;
  fat?: number | null;
  carbs?: number | null;
  image_key?: string | null;
}

interface ExtractedDailyLog {
  log_date?: string | null;
  weight?: number | null;
  sleep_hours?: number | null;
  sleep_quality?: SleepQuality | null;
  note?: string | null;
}

interface ExtractedUserPatch {
  nickname?: string | null;
  avatar_key?: string | null;
}

interface ExtractedHealthMetricUpdate {
  id?: string;
  value?: string;
  unit?: string | null;
  recorded_at?: string | null;
}

interface ExtractedDietRecordDelete {
  id?: string;
  meal_type?: MealType;
  record_date?: string | null;
}

interface ExtractedWritebackPayload {
  user?: ExtractedUserPatch;
  profile?: ExtractedProfilePatch;
  conditions?: ExtractedCondition[];
  conditions_mode?: ConditionsWriteMode | null;
  conditions_delete_ids?: string[];
  training_goals?: ExtractedTrainingGoal[];
  training_goals_mode?: TrainingGoalsWriteMode | null;
  training_goals_delete_ids?: string[];
  health_metrics?: ExtractedMetric[];
  health_metrics_update?: ExtractedHealthMetricUpdate[];
  health_metrics_delete_ids?: string[];
  training_plan?: ExtractedTrainingPlan | null;
  training_plan_delete_date?: string | null;
  nutrition_plan?: ExtractedPlan | null;
  nutrition_plan_delete_date?: string | null;
  supplement_plan?: ExtractedPlan | null;
  supplement_plan_delete_date?: string | null;
  diet_records?: ExtractedDietRecord[];
  diet_records_delete?: ExtractedDietRecordDelete[];
  daily_log?: ExtractedDailyLog | null;
  daily_log_delete_date?: string | null;
}

export const SYSTEM_PROMPTS: Record<AIRole, string> = {
  doctor: DOCTOR_SYSTEM_PROMPT,
  rehab: REHAB_SYSTEM_PROMPT,
  nutritionist: NUTRITIONIST_SYSTEM_PROMPT,
  trainer: TRAINER_SYSTEM_PROMPT,
};

export const ROLE_NAMES: Record<AIRole, string> = {
  doctor: '运动医生',
  rehab: '康复师',
  nutritionist: '营养师',
  trainer: '私人教练',
};

const VALID_GENDER: Gender[] = ['male', 'female'];
const VALID_SEVERITY: Severity[] = ['mild', 'moderate', 'severe'];
const VALID_STATUS: ConditionStatus[] = ['active', 'recovered'];
const VALID_TRAINING_GOAL_STATUS: TrainingGoalStatus[] = ['active', 'completed'];
const VALID_CONDITION_WRITE_MODES: ConditionsWriteMode[] = ['upsert', 'replace_all', 'clear_all'];
const VALID_TRAINING_GOAL_WRITE_MODES: TrainingGoalsWriteMode[] = ['upsert', 'replace_all', 'clear_all'];
const VALID_METRIC_TYPES: MetricType[] = ['testosterone', 'blood_pressure', 'blood_lipids', 'blood_sugar', 'heart_rate', 'body_fat', 'other'];
const VALID_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const VALID_SLEEP_QUALITIES: SleepQuality[] = ['good', 'fair', 'poor'];

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function asDateOnly(input: string | undefined): string {
  if (input && DATE_ONLY_REGEX.test(input)) return input;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateOnly: string, offsetDays: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getWeekMonday(dateOnly: string): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function inferTrainingPlanDate(rawPlanDate: unknown, sourceText: string): string {
  if (typeof rawPlanDate === 'string' && DATE_ONLY_REGEX.test(rawPlanDate)) {
    return rawPlanDate;
  }

  const explicitDate = sourceText.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (explicitDate && DATE_ONLY_REGEX.test(explicitDate)) {
    return explicitDate;
  }

  const today = asDateOnly(undefined);
  if (/(后天)/.test(sourceText)) return addDays(today, 2);
  if (/(明天|明日)/.test(sourceText)) return addDays(today, 1);
  if (/(本周|一周|7天|七天|周计划)/.test(sourceText)) return getWeekMonday(today);
  if (/(今天|今日)/.test(sourceText)) return today;

  return today;
}

function inferRecordDate(rawDate: unknown, sourceText: string): string {
  if (typeof rawDate === 'string' && DATE_ONLY_REGEX.test(rawDate)) {
    return rawDate;
  }
  const explicitDate = sourceText.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (explicitDate && DATE_ONLY_REGEX.test(explicitDate)) {
    return explicitDate;
  }

  const today = asDateOnly(undefined);
  if (/(昨天|昨日)/.test(sourceText)) return addDays(today, -1);
  if (/(前天)/.test(sourceText)) return addDays(today, -2);
  if (/(后天)/.test(sourceText)) return addDays(today, 2);
  if (/(明天|明日)/.test(sourceText)) return addDays(today, 1);
  return today;
}

function normalizeString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function normalizeTimeHHmm(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function applyTimeFieldPatch(
  patch: ExtractedProfilePatch,
  fieldName: 'training_start_time' | 'breakfast_time' | 'lunch_time' | 'dinner_time',
  fields: string[],
  values: unknown[]
): void {
  const value = patch[fieldName];
  if (value === undefined) return;
  if (value === null) {
    fields.push(`${fieldName} = ?`);
    values.push(null);
    return;
  }
  const normalized = normalizeTimeHHmm(value);
  if (normalized) {
    fields.push(`${fieldName} = ?`);
    values.push(normalized);
  }
}

function normalizeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function normalizeTrainingGoalsMode(value: unknown): TrainingGoalsWriteMode | null {
  if (typeof value !== 'string') return null;
  return VALID_TRAINING_GOAL_WRITE_MODES.includes(value as TrainingGoalsWriteMode)
    ? (value as TrainingGoalsWriteMode)
    : null;
}

function normalizeConditionsMode(value: unknown): ConditionsWriteMode | null {
  if (typeof value !== 'string') return null;
  return VALID_CONDITION_WRITE_MODES.includes(value as ConditionsWriteMode)
    ? (value as ConditionsWriteMode)
    : null;
}

function isMeaningfulTrainingGoalName(name: string): boolean {
  const compact = name
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?,.；;:：“”"'`（）()【】\[\]{}<>]/g, '');

  if (compact.length < 2) return false;
  if (
    /^(好|好的|ok|okay|yes|明白|收到|了解|知道了|可以|行|嗯|完成|done|已完成|已删除|已清空)$/.test(compact)
  ) {
    return false;
  }
  if (/(清空|删除|移除|重置|取消)(目标)?$/.test(compact)) return false;
  return true;
}

function getTrainingGoalMergeKey(name: string): string {
  const compact = name.trim().toLowerCase().replace(/\s+/g, '');
  if (!compact) return '';

  if (/(增肌|增重|长肌|肌肉增长|肌肥大)/.test(compact)) return 'goal:muscle_gain';
  if (/(减脂|减重|减肥|瘦身|降脂|控脂)/.test(compact)) return 'goal:fat_loss';
  if (/(力量|爆发力|最大力量|卧推|深蹲|硬拉)/.test(compact)) return 'goal:strength';
  if (/(耐力|有氧|心肺|跑步|马拉松)/.test(compact)) return 'goal:endurance';
  if (/(康复|恢复|伤病|疼痛缓解)/.test(compact)) return 'goal:rehab';
  if (/(体态|柔韧|灵活|活动度)/.test(compact)) return 'goal:mobility';

  return `goal:${compact}`;
}

async function applyProfilePatch(db: D1Database, userId: string, patch: ExtractedProfilePatch | undefined): Promise<boolean> {
  if (!patch || typeof patch !== 'object') return false;
  const fields: string[] = [];
  const values: unknown[] = [];

  if (typeof patch.height === 'number' && Number.isFinite(patch.height) && patch.height >= 50 && patch.height <= 300) {
    fields.push('height = ?');
    values.push(patch.height);
  }
  if (typeof patch.weight === 'number' && Number.isFinite(patch.weight) && patch.weight >= 20 && patch.weight <= 500) {
    fields.push('weight = ?');
    values.push(patch.weight);
  }
  if (typeof patch.birth_date === 'string' && DATE_ONLY_REGEX.test(patch.birth_date)) {
    fields.push('birth_date = ?');
    values.push(patch.birth_date);
  }
  if (typeof patch.gender === 'string' && VALID_GENDER.includes(patch.gender as Gender)) {
    fields.push('gender = ?');
    values.push(patch.gender);
  }

  // 时间字段：训练开始时间、三餐时间
  applyTimeFieldPatch(patch, 'training_start_time', fields, values);
  applyTimeFieldPatch(patch, 'breakfast_time', fields, values);
  applyTimeFieldPatch(patch, 'lunch_time', fields, values);
  applyTimeFieldPatch(patch, 'dinner_time', fields, values);

  if (
    typeof patch.training_years === 'number' &&
    Number.isFinite(patch.training_years) &&
    patch.training_years >= 0 &&
    patch.training_years <= 80
  ) {
    fields.push('training_years = ?');
    values.push(Number(patch.training_years.toFixed(1)));
  }
  if (typeof patch.training_goal === 'string') {
    const trainingGoal = normalizeString(patch.training_goal, 200);
    if (trainingGoal) {
      fields.push('training_goal = ?');
      values.push(trainingGoal);
    }
  }

  if (fields.length === 0) return false;
  await db.prepare('INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)').bind(userId).run();
  fields.push("updated_at = datetime('now')");
  await db.prepare(`UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = ?`)
    .bind(...values, userId)
    .run();
  return true;
}

function isValidAvatarKeyForUser(key: string, userId: string): boolean {
  return key.startsWith(`chat-images/${userId}/`);
}

async function applyUserPatch(db: D1Database, userId: string, patch: ExtractedUserPatch | undefined): Promise<boolean> {
  if (!patch || typeof patch !== 'object') return false;
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.nickname !== undefined) {
    if (patch.nickname === null) {
      fields.push('nickname = ?');
      values.push(null);
    } else if (typeof patch.nickname === 'string') {
      const nickname = normalizeString(patch.nickname, 50);
      fields.push('nickname = ?');
      values.push(nickname || null);
    }
  }

  if (patch.avatar_key !== undefined) {
    if (patch.avatar_key === null) {
      fields.push('avatar_key = ?');
      values.push(null);
    } else if (typeof patch.avatar_key === 'string') {
      const avatarKey = normalizeString(patch.avatar_key, 512);
      if (!avatarKey) {
        fields.push('avatar_key = ?');
        values.push(null);
      } else if (isValidAvatarKeyForUser(avatarKey, userId)) {
        fields.push('avatar_key = ?');
        values.push(avatarKey);
      }
    }
  }

  if (fields.length === 0) return false;
  values.push(userId);
  const res = await db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  return Boolean(res.meta?.changes);
}

async function deleteByIds(db: D1Database, table: string, userId: string, ids: string[] | undefined, max: number): Promise<number> {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const unique = Array.from(new Set(ids.map((id) => normalizeString(id, 64)).filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return 0;
  const statements = unique.slice(0, max).map((id) =>
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId)
  );
  const results = await db.batch(statements);
  return results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
}

async function countRowsForUser(db: D1Database, table: string, userId: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(1) as total FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first<{ total: number | string | null }>();
  return Number(row?.total ?? 0);
}

async function applyConditions(
  db: D1Database,
  userId: string,
  rawConditions: ExtractedCondition[] | undefined,
  mode: ConditionsWriteMode | null | undefined
): Promise<number> {
  const normalizedMode: ConditionsWriteMode = normalizeConditionsMode(mode) ?? 'upsert';
  const existingCount = await countRowsForUser(db, 'conditions', userId);

  if (normalizedMode === 'clear_all') {
    if (existingCount <= 0) return 0;
    await db.prepare('DELETE FROM conditions WHERE user_id = ?').bind(userId).run();
    return 0;
  }

  const seen = new Set<string>();
  const candidates: Array<{
    name: string;
    dedupeKey: string;
    description: string | null;
    severity: Severity | null;
    status: ConditionStatus;
  }> = [];

  for (const item of (Array.isArray(rawConditions) ? rawConditions : []).slice(0, 5)) {
    const name = normalizeString(item?.name, 100);
    if (!name) continue;
    const dedupeKey = name.trim().toLowerCase();
    if (!dedupeKey) continue;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const description = item?.description == null ? null : normalizeString(item.description, 500);
    const severity = typeof item?.severity === 'string' && VALID_SEVERITY.includes(item.severity as Severity)
      ? (item.severity as Severity)
      : null;
    const status = typeof item?.status === 'string' && VALID_STATUS.includes(item.status as ConditionStatus)
      ? (item.status as ConditionStatus)
      : 'active';

    candidates.push({ name, dedupeKey, description, severity, status });
  }

  if (normalizedMode === 'replace_all') {
    const statements = [db.prepare('DELETE FROM conditions WHERE user_id = ?').bind(userId)];
    for (const item of candidates) {
      const id = crypto.randomUUID();
      statements.push(
        db.prepare(
          'INSERT INTO conditions (id, user_id, name, description, severity, status) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, userId, item.name, item.description, item.severity, item.status)
      );
    }
    await db.batch(statements);
    return candidates.length;
  }

  // upsert
  if (candidates.length === 0) return 0;
  let upserted = 0;

  for (const item of candidates) {
    const existing = await db.prepare(
      'SELECT id FROM conditions WHERE user_id = ? AND lower(name) = lower(?) LIMIT 1'
    )
      .bind(userId, item.name)
      .first<{ id: string }>();

    if (existing?.id) {
      await db.prepare(
        'UPDATE conditions SET description = ?, severity = ?, status = ? WHERE id = ? AND user_id = ?'
      )
        .bind(item.description, item.severity, item.status, existing.id, userId)
        .run();
    } else {
      const id = crypto.randomUUID();
      await db.prepare(
        'INSERT INTO conditions (id, user_id, name, description, severity, status) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, userId, item.name, item.description, item.severity, item.status)
        .run();
    }

    upserted += 1;
  }

  return upserted;
}

async function applyTrainingGoals(
  db: D1Database,
  userId: string,
  rawGoals: ExtractedTrainingGoal[] | undefined,
  mode: TrainingGoalsWriteMode | null | undefined
): Promise<number> {
  const normalizedMode: TrainingGoalsWriteMode = normalizeTrainingGoalsMode(mode) ?? 'upsert';
  const seen = new Set<string>();
  const candidates: Array<{
    name: string;
    dedupeKey: string;
    description: string | null;
    status: TrainingGoalStatus | null;
  }> = [];

  for (const item of (Array.isArray(rawGoals) ? rawGoals : []).slice(0, 5)) {
    const name = normalizeString(item?.name, 100);
    if (!name) continue;
    if (!isMeaningfulTrainingGoalName(name)) continue;
    const dedupeKey = getTrainingGoalMergeKey(name);
    if (!dedupeKey) continue;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const description = item?.description == null ? null : normalizeString(item.description, 4000);
    const status = typeof item?.status === 'string' && VALID_TRAINING_GOAL_STATUS.includes(item.status as TrainingGoalStatus)
      ? (item.status as TrainingGoalStatus)
      : null;
    candidates.push({ name, dedupeKey, description, status });
  }

  const existingCount = await countRowsForUser(db, 'training_goals', userId);

  if (normalizedMode === 'clear_all') {
    if (existingCount <= 0) return 0;
    await db.prepare('DELETE FROM training_goals WHERE user_id = ?').bind(userId).run();
    return 0;
  }

  if (normalizedMode === 'replace_all') {
    const statements = [db.prepare('DELETE FROM training_goals WHERE user_id = ?').bind(userId)];
    for (const item of candidates) {
      const id = crypto.randomUUID();
      statements.push(
        db.prepare(
          'INSERT INTO training_goals (id, user_id, name, description, status) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, userId, item.name, item.description, item.status || 'active')
      );
    }
    await db.batch(statements);
    return candidates.length;
  }

  if (candidates.length === 0) return 0;
  let upserted = 0;

  const existingGoalsResult = await db.prepare(
    'SELECT id, name FROM training_goals WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<{ id: string; name: string }>();
  const existingByKey = new Map<string, { id: string }>();
  for (const row of existingGoalsResult.results || []) {
    if (!row?.id || !row?.name) continue;
    const key = getTrainingGoalMergeKey(row.name);
    if (!key) continue;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, { id: row.id });
    }
  }

  for (const item of candidates) {
    const existing = existingByKey.get(item.dedupeKey) || null;

    if (existing) {
      await db.prepare(
        'UPDATE training_goals SET name = ?, description = COALESCE(?, description), status = COALESCE(?, status) WHERE id = ? AND user_id = ?'
      )
        .bind(item.name, item.description, item.status, existing.id, userId)
        .run();
    } else {
      const id = crypto.randomUUID();
      await db.prepare(
        'INSERT INTO training_goals (id, user_id, name, description, status) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(id, userId, item.name, item.description, item.status || 'active')
        .run();
      existingByKey.set(item.dedupeKey, { id });
    }

    upserted += 1;
  }

  return upserted;
}

async function applyHealthMetrics(db: D1Database, userId: string, rawMetrics: ExtractedMetric[] | undefined): Promise<number> {
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) return 0;
  let created = 0;

  for (const item of rawMetrics.slice(0, 6)) {
    if (!item || typeof item !== 'object') continue;
    const metricType = item.metric_type;
    if (typeof metricType !== 'string' || !VALID_METRIC_TYPES.includes(metricType as MetricType)) continue;

    let valueText: string | null = null;
    if (typeof item.value === 'string') {
      valueText = normalizeString(item.value, 500);
    } else if (item.value !== undefined && item.value !== null) {
      try {
        valueText = normalizeString(JSON.stringify(item.value), 500);
      } catch {
        valueText = null;
      }
    }
    if (!valueText) continue;

    const unit = item.unit == null ? null : normalizeString(item.unit, 20);
    const recordedAt = typeof item.recorded_at === 'string' && isISODateString(item.recorded_at)
      ? item.recorded_at
      : null;

    const id = crypto.randomUUID();
    await db.prepare(
      'INSERT INTO health_metrics (id, user_id, metric_type, value, unit, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(id, userId, metricType, valueText, unit, recordedAt)
      .run();

    created += 1;
  }

  return created;
}

async function applyHealthMetricUpdates(
  db: D1Database,
  userId: string,
  updates: ExtractedHealthMetricUpdate[] | undefined
): Promise<number> {
  if (!Array.isArray(updates) || updates.length === 0) return 0;
  let updated = 0;

  for (const item of updates.slice(0, 10)) {
    const id = normalizeString(item?.id, 64);
    if (!id) continue;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (typeof item?.value === 'string') {
      const valueText = normalizeString(item.value, 500);
      if (valueText) {
        fields.push('value = ?');
        values.push(valueText);
      }
    }

    if (item?.unit !== undefined) {
      if (item.unit === null) {
        fields.push('unit = ?');
        values.push(null);
      } else if (typeof item.unit === 'string') {
        const unitText = normalizeString(item.unit, 20);
        fields.push('unit = ?');
        values.push(unitText || null);
      }
    }

    if (typeof item?.recorded_at === 'string' && DATE_ONLY_REGEX.test(item.recorded_at)) {
      fields.push('recorded_at = ?');
      values.push(item.recorded_at);
    }

    if (fields.length === 0) continue;
    values.push(id, userId);

    const res = await db.prepare(
      `UPDATE health_metrics SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`
    )
      .bind(...values)
      .run();

    if (res.meta?.changes) updated += 1;
  }

  return updated;
}

async function applyTrainingPlan(
  db: D1Database,
  userId: string,
  plan: ExtractedTrainingPlan | null | undefined,
  contextText?: string
): Promise<boolean> {
  if (!plan || typeof plan !== 'object') return false;

  const content = normalizeString(plan.content, 12000);
  if (!content || content.length < 12) return false;

  const planDate = inferTrainingPlanDate(plan.plan_date, `${contextText || ''}\n${content}`);
  const notes = plan.notes == null ? null : normalizeString(plan.notes, 500);
  const completed = plan.completed === true || plan.completed === 1 ? 1 : 0;

  // 同一天只保留一份计划，遵循 /api/training 的行为
  await db.prepare('DELETE FROM training_plans WHERE user_id = ? AND plan_date = ?')
    .bind(userId, planDate)
    .run();

  const id = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO training_plans (id, user_id, plan_date, content, completed, notes) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, planDate, content, completed, notes)
    .run();

  return true;
}

async function deleteTrainingPlanByDate(
  db: D1Database,
  userId: string,
  rawDate: unknown,
  contextText?: string
): Promise<boolean> {
  const planDate = inferTrainingPlanDate(rawDate, contextText || '');
  const res = await db.prepare('DELETE FROM training_plans WHERE user_id = ? AND plan_date = ?')
    .bind(userId, planDate)
    .run();
  return Boolean(res.meta?.changes);
}

async function deleteNutritionPlanByDate(
  db: D1Database,
  userId: string,
  rawDate: unknown,
  type: 'nutrition' | 'supplement',
  contextText?: string
): Promise<boolean> {
  const planDate = inferTrainingPlanDate(rawDate, contextText || '');
  const res = type === 'supplement'
    ? await db.prepare(
      "DELETE FROM nutrition_plans WHERE user_id = ? AND plan_date = ? AND content LIKE '【补剂方案】%'"
    )
      .bind(userId, planDate)
      .run()
    : await db.prepare(
      "DELETE FROM nutrition_plans WHERE user_id = ? AND plan_date = ? AND content NOT LIKE '【补剂方案】%'"
    )
      .bind(userId, planDate)
      .run();
  return Boolean(res.meta?.changes);
}

async function applyDietRecords(
  db: D1Database,
  userId: string,
  rawRecords: ExtractedDietRecord[] | undefined,
  contextText?: string
): Promise<number> {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) return 0;

  let created = 0;
  const seen = new Set<string>();

  for (const item of rawRecords.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;

    const mealType =
      typeof item.meal_type === 'string' && VALID_MEAL_TYPES.includes(item.meal_type as MealType)
        ? (item.meal_type as MealType)
        : null;
    if (!mealType) continue;

    const foodDescription = normalizeString(item.food_description, 1000);
    if (!foodDescription) continue;
    const recordDate = inferRecordDate(item.record_date, `${contextText || ''}\n${foodDescription}`);

    const dedupeKey = `${mealType}|${recordDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let foodsJson: string | null = null;
    if (typeof item.foods_json === 'string') {
      foodsJson = normalizeString(item.foods_json, 8000);
    } else if (item.foods_json !== undefined && item.foods_json !== null) {
      try {
        foodsJson = normalizeString(JSON.stringify(item.foods_json), 8000);
      } catch {
        foodsJson = null;
      }
    }

    const calories = normalizeNumber(item.calories, 0, 10000);
    const protein = normalizeNumber(item.protein, 0, 2000);
    const fat = normalizeNumber(item.fat, 0, 2000);
    const carbs = normalizeNumber(item.carbs, 0, 2000);
    const imageKey = item.image_key == null ? null : normalizeString(item.image_key, 512);

    // AI 写回采用“同日同餐替换”策略，避免同一餐生成多个冲突记录
    await db.prepare(
      'DELETE FROM diet_records WHERE user_id = ? AND meal_type = ? AND record_date = ?'
    )
      .bind(userId, mealType, recordDate)
      .run();

    const id = crypto.randomUUID();
    await db.prepare(
      'INSERT INTO diet_records (id, user_id, meal_type, record_date, food_description, foods_json, calories, protein, fat, carbs, image_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, userId, mealType, recordDate, foodDescription, foodsJson, calories, protein, fat, carbs, imageKey)
      .run();

    created += 1;
  }

  return created;
}

async function deleteDietRecords(
  db: D1Database,
  userId: string,
  deletes: ExtractedDietRecordDelete[] | undefined,
  contextText?: string
): Promise<number> {
  if (!Array.isArray(deletes) || deletes.length === 0) return 0;

  let deleted = 0;
  const seen = new Set<string>();

  for (const item of deletes.slice(0, 8)) {
    const id = normalizeString(item?.id, 64);
    if (id) {
      if (seen.has(`id:${id}`)) continue;
      seen.add(`id:${id}`);
      // eslint-disable-next-line no-await-in-loop
      const res = await db.prepare('DELETE FROM diet_records WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .run();
      deleted += res.meta?.changes || 0;
      continue;
    }

    const mealType =
      typeof item?.meal_type === 'string' && VALID_MEAL_TYPES.includes(item.meal_type as MealType)
        ? (item.meal_type as MealType)
        : null;
    if (!mealType) continue;

    const recordDate = inferRecordDate(item?.record_date, contextText || '');
    const dedupeKey = `${mealType}|${recordDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // eslint-disable-next-line no-await-in-loop
    const res = await db.prepare('DELETE FROM diet_records WHERE user_id = ? AND meal_type = ? AND record_date = ?')
      .bind(userId, mealType, recordDate)
      .run();
    deleted += res.meta?.changes || 0;
  }

  return deleted;
}

async function applyNutritionPlan(
  db: D1Database,
  userId: string,
  plan: ExtractedPlan | null | undefined,
  type: 'nutrition' | 'supplement'
): Promise<boolean> {
  if (!plan || typeof plan !== 'object') return false;
  const contentRaw = normalizeString(plan.content, 6000);
  if (!contentRaw || contentRaw.length < 12) return false;
  const planDate = asDateOnly(plan.plan_date);
  const content = type === 'supplement' && !contentRaw.startsWith('【补剂方案】')
    ? `【补剂方案】\n${contentRaw}`
    : contentRaw;

  // 同一天同类型只保留一份方案，避免重复堆叠导致用户无从选择
  if (type === 'supplement') {
    await db.prepare(
      "DELETE FROM nutrition_plans WHERE user_id = ? AND plan_date = ? AND content LIKE '【补剂方案】%'"
    )
      .bind(userId, planDate)
      .run();
  } else {
    await db.prepare(
      "DELETE FROM nutrition_plans WHERE user_id = ? AND plan_date = ? AND content NOT LIKE '【补剂方案】%'"
    )
      .bind(userId, planDate)
      .run();
  }

  const id = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO nutrition_plans (id, user_id, plan_date, content) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, planDate, content)
    .run();

  return true;
}

async function applyDailyLog(
  db: D1Database,
  userId: string,
  dailyLog: ExtractedDailyLog | null | undefined
): Promise<boolean> {
  if (!dailyLog || typeof dailyLog !== 'object') return false;

  const logDate =
    typeof dailyLog.log_date === 'string' && DATE_ONLY_REGEX.test(dailyLog.log_date)
      ? dailyLog.log_date
      : asDateOnly(undefined);

  const weight =
    typeof dailyLog.weight === 'number' &&
      Number.isFinite(dailyLog.weight) &&
      dailyLog.weight >= 20 &&
      dailyLog.weight <= 500
      ? dailyLog.weight
      : null;

  const sleepHours =
    typeof dailyLog.sleep_hours === 'number' &&
      Number.isFinite(dailyLog.sleep_hours) &&
      dailyLog.sleep_hours >= 0 &&
      dailyLog.sleep_hours <= 24
      ? dailyLog.sleep_hours
      : null;

  const sleepQuality =
    typeof dailyLog.sleep_quality === 'string' &&
      VALID_SLEEP_QUALITIES.includes(dailyLog.sleep_quality as SleepQuality)
      ? dailyLog.sleep_quality
      : null;

  const note = dailyLog.note == null ? null : normalizeString(dailyLog.note, 500);

  if (weight === null && sleepHours === null && sleepQuality === null && note === null) {
    return false;
  }

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO daily_logs (id, user_id, log_date, weight, sleep_hours, sleep_quality, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       weight = COALESCE(excluded.weight, daily_logs.weight),
       sleep_hours = COALESCE(excluded.sleep_hours, daily_logs.sleep_hours),
       sleep_quality = COALESCE(excluded.sleep_quality, daily_logs.sleep_quality),
       note = COALESCE(excluded.note, daily_logs.note)`
  )
    .bind(id, userId, logDate, weight, sleepHours, sleepQuality, note)
    .run();

  return true;
}

async function deleteDailyLogByDate(
  db: D1Database,
  userId: string,
  rawDate: unknown,
  contextText?: string
): Promise<boolean> {
  const logDate = inferRecordDate(rawDate, contextText || '');
  const res = await db.prepare('DELETE FROM daily_logs WHERE user_id = ? AND log_date = ?')
    .bind(userId, logDate)
    .run();
  return Boolean(res.meta?.changes);
}

export async function applyAutoWriteback(
  db: D1Database,
  userId: string,
  extracted: ExtractedWritebackPayload | null,
  options?: { contextText?: string | null }
): Promise<OrchestrateAutoWriteSummary> {
  const summary: OrchestrateAutoWriteSummary = {
    profile_updated: false,
    user_updated: false,
    conditions_upserted: 0,
    conditions_deleted: 0,
    training_goals_upserted: 0,
    training_goals_deleted: 0,
    health_metrics_created: 0,
    health_metrics_updated: 0,
    health_metrics_deleted: 0,
    training_plan_created: false,
    training_plan_deleted: false,
    nutrition_plan_created: false,
    nutrition_plan_deleted: false,
    supplement_plan_created: false,
    supplement_plan_deleted: false,
    diet_records_created: 0,
    diet_records_deleted: 0,
    daily_log_upserted: false,
    daily_log_deleted: false,
  };

  if (!extracted) return summary;

  summary.user_updated = await applyUserPatch(db, userId, extracted.user);
  summary.profile_updated = await applyProfilePatch(db, userId, extracted.profile);
  const contextText = typeof options?.contextText === 'string' ? options.contextText : '';

  // --- Conditions (伤病) ---
  const conditionsMode = normalizeConditionsMode(extracted.conditions_mode) ?? 'upsert';
  if (conditionsMode === 'clear_all') {
    summary.conditions_deleted = await countRowsForUser(db, 'conditions', userId);
    await applyConditions(db, userId, undefined, 'clear_all');
  } else if (conditionsMode === 'replace_all') {
    summary.conditions_deleted = await countRowsForUser(db, 'conditions', userId);
    summary.conditions_upserted = await applyConditions(db, userId, extracted.conditions, 'replace_all');
  } else {
    summary.conditions_deleted = await deleteByIds(db, 'conditions', userId, extracted.conditions_delete_ids, 10);
    summary.conditions_upserted = await applyConditions(db, userId, extracted.conditions, 'upsert');
  }

  // --- Training goals (训练目标) ---
  const goalsMode = normalizeTrainingGoalsMode(extracted.training_goals_mode) ?? 'upsert';
  if (goalsMode === 'clear_all') {
    summary.training_goals_deleted = await countRowsForUser(db, 'training_goals', userId);
    await applyTrainingGoals(db, userId, undefined, 'clear_all');
  } else if (goalsMode === 'replace_all') {
    summary.training_goals_deleted = await countRowsForUser(db, 'training_goals', userId);
    summary.training_goals_upserted = await applyTrainingGoals(db, userId, extracted.training_goals, 'replace_all');
  } else {
    summary.training_goals_deleted = await deleteByIds(db, 'training_goals', userId, extracted.training_goals_delete_ids, 10);
    summary.training_goals_upserted = await applyTrainingGoals(db, userId, extracted.training_goals, 'upsert');
  }

  // --- Health metrics (理化指标) ---
  summary.health_metrics_updated = await applyHealthMetricUpdates(db, userId, extracted.health_metrics_update);
  summary.health_metrics_deleted = await deleteByIds(db, 'health_metrics', userId, extracted.health_metrics_delete_ids, 10);
  summary.health_metrics_created = await applyHealthMetrics(db, userId, extracted.health_metrics);

  // --- Training plan (训练计划/记录) ---
  if (extracted.training_plan_delete_date) {
    summary.training_plan_deleted = await deleteTrainingPlanByDate(db, userId, extracted.training_plan_delete_date, contextText);
  }
  summary.training_plan_created = await applyTrainingPlan(db, userId, extracted.training_plan, contextText);

  // --- Nutrition plans (饮食/补剂方案) ---
  if (extracted.nutrition_plan_delete_date) {
    summary.nutrition_plan_deleted = await deleteNutritionPlanByDate(db, userId, extracted.nutrition_plan_delete_date, 'nutrition', contextText);
  }
  if (extracted.supplement_plan_delete_date) {
    summary.supplement_plan_deleted = await deleteNutritionPlanByDate(db, userId, extracted.supplement_plan_delete_date, 'supplement', contextText);
  }
  summary.nutrition_plan_created = await applyNutritionPlan(db, userId, extracted.nutrition_plan, 'nutrition');
  summary.supplement_plan_created = await applyNutritionPlan(db, userId, extracted.supplement_plan, 'supplement');

  // --- Diet records (饮食记录) ---
  summary.diet_records_deleted = await deleteDietRecords(db, userId, extracted.diet_records_delete, contextText);
  summary.diet_records_created = await applyDietRecords(db, userId, extracted.diet_records, contextText);

  // --- Daily log (体重/睡眠) ---
  if (extracted.daily_log_delete_date) {
    summary.daily_log_deleted = await deleteDailyLogByDate(db, userId, extracted.daily_log_delete_date, contextText);
  }
  summary.daily_log_upserted = await applyDailyLog(db, userId, extracted.daily_log);

  return summary;
}

export async function saveOrchestrateUserMessage(
  db: D1Database,
  userId: string,
  userMessage: string,
  imageUrl: string | null
): Promise<void> {
  const userIdRow = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO chat_history (id, user_id, role, message_role, content, image_url) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(userIdRow, userId, 'orchestrator', 'user', userMessage, imageUrl)
    .run();
}

export async function saveOrchestrateAssistantMessage(
  db: D1Database,
  userId: string,
  answer: string,
  metadata?: Record<string, unknown> | null
): Promise<void> {
  const assistantId = crypto.randomUUID();
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  await db.prepare(
    'INSERT INTO chat_history (id, user_id, role, message_role, content, metadata) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(assistantId, userId, 'orchestrator', 'assistant', answer, metadataJson)
    .run();
}

export type WritebackAuditSource = 'orchestrate_stream' | 'writeback_commit';

export async function recordWritebackAudit(
  db: D1Database,
  userId: string,
  source: WritebackAuditSource,
  summary: OrchestrateAutoWriteSummary | null,
  error: string | null,
  messageExcerpt: string
): Promise<void> {
  const id = crypto.randomUUID();
  const status = error ? 'failed' : 'success';
  const summaryJson = summary ? JSON.stringify(summary) : null;
  const excerpt = messageExcerpt.length > 200 ? messageExcerpt.slice(0, 200) : messageExcerpt;
  await db.prepare(
    'INSERT INTO ai_writeback_audits (id, user_id, source, status, summary_json, error, message_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, source, status, summaryJson, error, excerpt)
    .run();
}

export type AgentRuntimeEventType =
  | 'policy_snapshot'
  | 'lifecycle_state'
  | 'tool_call'
  | 'tool_result'
  | 'writeback_result'
  | 'error';

export interface AgentRuntimeEventInput {
  userId: string;
  sessionId: string;
  requestId: string;
  flowMode: string;
  eventType: AgentRuntimeEventType;
  payload?: Record<string, unknown> | null;
}

const RUNTIME_REDACT_KEYS = ['token', 'secret', 'password', 'api_key', 'authorization'];

function sanitizeRuntimePayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const lowerKey = key.toLowerCase();
    if (RUNTIME_REDACT_KEYS.some((frag) => lowerKey.includes(frag))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      sanitized[key] = value.length > 1000 ? `${value.slice(0, 1000)}...(truncated)` : value;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export async function recordAgentRuntimeEvent(
  db: D1Database,
  input: AgentRuntimeEventInput
): Promise<void> {
  const id = crypto.randomUUID();
  const flowMode = (input.flowMode || '').slice(0, 24) || 'governed';
  const sanitizedPayload = sanitizeRuntimePayload(input.payload);
  const payloadJsonRaw = sanitizedPayload ? JSON.stringify(sanitizedPayload) : null;
  const payloadJson = payloadJsonRaw && payloadJsonRaw.length > 12000
    ? `${payloadJsonRaw.slice(0, 12000)}...(truncated)`
    : payloadJsonRaw;
  await db.prepare(
    'INSERT INTO agent_runtime_events (id, user_id, session_id, request_id, flow_mode, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      id,
      input.userId,
      input.sessionId || 'default',
      input.requestId || 'unknown',
      flowMode,
      input.eventType,
      payloadJson
    )
    .run();
}
