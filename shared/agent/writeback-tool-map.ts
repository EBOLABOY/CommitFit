export const WRITEBACK_TOOL_NAMES = [
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
] as const;

export type WritebackToolName = (typeof WRITEBACK_TOOL_NAMES)[number];

export interface WritebackToolTransformResult {
  payload: Record<string, unknown>;
  summary_text: string;
}

const WRITEBACK_TOOL_SET = new Set<string>(WRITEBACK_TOOL_NAMES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  return v.length > 0 ? v : fallback;
}

function pickSummary(input: Record<string, unknown>, fallback: string): string {
  return asText(input.summary_text, fallback);
}

export function isWritebackToolName(toolName: string): toolName is WritebackToolName {
  return WRITEBACK_TOOL_SET.has(toolName);
}

export function transformWritebackToolInput(
  toolName: WritebackToolName,
  input: unknown
): WritebackToolTransformResult | null {
  if (!isPlainObject(input)) return null;

  switch (toolName) {
    case 'user_patch': {
      const userPatch: Record<string, unknown> = {};
      if ('nickname' in input) userPatch.nickname = input.nickname;
      if ('avatar_key' in input) userPatch.avatar_key = input.avatar_key;
      if (Object.keys(userPatch).length === 0) return null;
      return {
        payload: { user: userPatch },
        summary_text: pickSummary(input, '更新用户信息'),
      };
    }
    case 'profile_patch': {
      const profilePatch: Record<string, unknown> = {};
      const keys = [
        'height',
        'weight',
        'birth_date',
        'gender',
        'training_start_time',
        'breakfast_time',
        'lunch_time',
        'dinner_time',
        'training_years',
        'training_goal',
      ];
      for (const key of keys) {
        if (key in input) profilePatch[key] = input[key];
      }
      if (Object.keys(profilePatch).length === 0) return null;
      return {
        payload: { profile: profilePatch },
        summary_text: pickSummary(input, '更新身体档案'),
      };
    }
    case 'conditions_upsert': {
      return {
        payload: { conditions: input.conditions, conditions_mode: 'upsert' },
        summary_text: pickSummary(input, '同步伤病记录'),
      };
    }
    case 'conditions_replace_all': {
      return {
        payload: { conditions: input.conditions, conditions_mode: 'replace_all' },
        summary_text: pickSummary(input, '替换全部伤病记录'),
      };
    }
    case 'conditions_delete': {
      return {
        payload: { conditions_delete_ids: input.ids },
        summary_text: pickSummary(input, '删除伤病记录'),
      };
    }
    case 'conditions_clear_all': {
      return {
        payload: { conditions_mode: 'clear_all' },
        summary_text: pickSummary(input, '清空伤病记录'),
      };
    }
    case 'training_goals_upsert': {
      return {
        payload: { training_goals: input.goals, training_goals_mode: 'upsert' },
        summary_text: pickSummary(input, '同步训练目标'),
      };
    }
    case 'training_goals_replace_all': {
      return {
        payload: { training_goals: input.goals, training_goals_mode: 'replace_all' },
        summary_text: pickSummary(input, '替换全部训练目标'),
      };
    }
    case 'training_goals_delete': {
      return {
        payload: { training_goals_delete_ids: input.ids },
        summary_text: pickSummary(input, '删除训练目标'),
      };
    }
    case 'training_goals_clear_all': {
      return {
        payload: { training_goals_mode: 'clear_all' },
        summary_text: pickSummary(input, '清空训练目标'),
      };
    }
    case 'health_metrics_create': {
      return {
        payload: { health_metrics: input.metrics },
        summary_text: pickSummary(input, '新增理化指标'),
      };
    }
    case 'health_metrics_update': {
      return {
        payload: { health_metrics_update: input.updates },
        summary_text: pickSummary(input, '更新理化指标'),
      };
    }
    case 'health_metrics_delete': {
      return {
        payload: { health_metrics_delete_ids: input.ids },
        summary_text: pickSummary(input, '删除理化指标'),
      };
    }
    case 'training_plan_set': {
      return {
        payload: {
          training_plan: {
            plan_date: input.plan_date,
            content: input.content,
            notes: input.notes,
            completed: input.completed,
          },
        },
        summary_text: pickSummary(input, '写入训练计划'),
      };
    }
    case 'training_plan_delete': {
      return {
        payload: { training_plan_delete_date: input.plan_date ?? '' },
        summary_text: pickSummary(input, '删除训练计划'),
      };
    }
    case 'nutrition_plan_set': {
      return {
        payload: {
          nutrition_plan: {
            plan_date: input.plan_date,
            content: input.content,
          },
        },
        summary_text: pickSummary(input, '写入营养方案'),
      };
    }
    case 'nutrition_plan_delete': {
      return {
        payload: { nutrition_plan_delete_date: input.plan_date ?? '' },
        summary_text: pickSummary(input, '删除营养方案'),
      };
    }
    case 'supplement_plan_set': {
      return {
        payload: {
          supplement_plan: {
            plan_date: input.plan_date,
            content: input.content,
          },
        },
        summary_text: pickSummary(input, '写入补剂方案'),
      };
    }
    case 'supplement_plan_delete': {
      return {
        payload: { supplement_plan_delete_date: input.plan_date ?? '' },
        summary_text: pickSummary(input, '删除补剂方案'),
      };
    }
    case 'diet_records_create': {
      return {
        payload: { diet_records: input.records },
        summary_text: pickSummary(input, '新增饮食记录'),
      };
    }
    case 'diet_records_delete': {
      return {
        payload: { diet_records_delete: input.deletes },
        summary_text: pickSummary(input, '删除饮食记录'),
      };
    }
    case 'daily_log_upsert': {
      return {
        payload: {
          daily_log: {
            log_date: input.log_date,
            weight: input.weight,
            sleep_hours: input.sleep_hours,
            sleep_quality: input.sleep_quality,
            note: input.note,
          },
        },
        summary_text: pickSummary(input, '写入每日日志'),
      };
    }
    case 'daily_log_delete': {
      return {
        payload: { daily_log_delete_date: input.log_date ?? '' },
        summary_text: pickSummary(input, '删除每日日志'),
      };
    }
    default:
      return null;
  }
}
