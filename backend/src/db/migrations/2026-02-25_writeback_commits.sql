-- Local-First 写回提交幂等表：用于保证同一 draft_id 只会被应用一次（可安全重试）

CREATE TABLE IF NOT EXISTS writeback_commits (
  draft_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending / success / failed
  payload_json TEXT NOT NULL,    -- 原始写回 payload（不含 summary_text）
  summary_json TEXT,             -- applyAutoWriteback 的摘要
  error TEXT,                    -- 失败原因（仅 failed）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_writeback_commits_user_created_at
  ON writeback_commits(user_id, created_at);

