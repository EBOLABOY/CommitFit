-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  avatar_key TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 身体基础数据
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  height REAL,
  weight REAL,
  birth_date TEXT,               -- YYYY-MM-DD
  age INTEGER,
  gender TEXT,
  training_start_time TEXT,      -- 每日训练开始时间（HH:mm，24小时制）
  breakfast_time TEXT,           -- 早餐时间（HH:mm，24小时制）
  lunch_time TEXT,               -- 午餐时间（HH:mm，24小时制）
  dinner_time TEXT,              -- 晚餐时间（HH:mm，24小时制）
  training_years REAL,           -- 训练年限（年）
  training_goal TEXT,
  experience_level TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 身体理化指标（运动医生模块）
CREATE TABLE IF NOT EXISTS health_metrics (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  metric_type TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  recorded_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 伤病/外科问题（康复师模块）
CREATE TABLE IF NOT EXISTS conditions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  severity TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 训练目标
CREATE TABLE IF NOT EXISTS training_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 训练计划
CREATE TABLE IF NOT EXISTS training_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  plan_date TEXT NOT NULL,
  content TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 营养方案
CREATE TABLE IF NOT EXISTS nutrition_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  plan_date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- AI 对话历史
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  role TEXT NOT NULL,
  message_role TEXT NOT NULL,
  content TEXT NOT NULL,
  image_url TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- AI 自动写回审计
CREATE TABLE IF NOT EXISTS ai_writeback_audits (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  source TEXT NOT NULL,              -- orchestrate / orchestrate_stream
  status TEXT NOT NULL,              -- success / failed
  summary_json TEXT,                 -- 写回摘要 JSON
  error TEXT,                        -- 失败原因
  message_excerpt TEXT,              -- 问题摘要（便于排查）
  created_at TEXT DEFAULT (datetime('now'))
);

-- Local-First 写回提交幂等表：用于保证同一 draft_id 只会被应用一次（可安全重试）
CREATE TABLE IF NOT EXISTS writeback_commits (
  draft_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL,              -- pending / success / failed
  payload_json TEXT NOT NULL,
  summary_json TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 饮食记录
CREATE TABLE IF NOT EXISTS diet_records (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  meal_type TEXT NOT NULL,        -- breakfast / lunch / dinner / snack
  record_date TEXT NOT NULL,      -- YYYY-MM-DD
  food_description TEXT NOT NULL, -- 用户原始描述
  foods_json TEXT,                -- AI 分析的食物明细 JSON
  calories REAL,
  protein REAL,
  fat REAL,
  carbs REAL,
  image_key TEXT,                 -- R2 图片 key（拍照输入时）
  created_at TEXT DEFAULT (datetime('now'))
);

-- 每日记录（体重、睡眠等）
CREATE TABLE IF NOT EXISTS daily_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  log_date TEXT NOT NULL,         -- YYYY-MM-DD
  weight REAL,                    -- 体重 kg
  sleep_hours REAL,               -- 睡眠时长 h
  sleep_quality TEXT,             -- good / fair / poor
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_health_metrics_user ON health_metrics(user_id);
CREATE INDEX IF NOT EXISTS idx_conditions_user ON conditions(user_id);
CREATE INDEX IF NOT EXISTS idx_training_goals_user ON training_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_training_plans_user ON training_plans(user_id, plan_date);
CREATE INDEX IF NOT EXISTS idx_nutrition_plans_user ON nutrition_plans(user_id, plan_date);
CREATE INDEX IF NOT EXISTS idx_chat_history_user_role ON chat_history(user_id, role, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_writeback_audits_user ON ai_writeback_audits(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_writeback_commits_user ON writeback_commits(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_diet_records_user ON diet_records(user_id, record_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs(user_id, log_date);
