-- Agent 运行时事件表：用于双轨并行下的策略/状态/工具执行对比分析
CREATE TABLE IF NOT EXISTS agent_runtime_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  flow_mode TEXT NOT NULL,          -- dual / governed
  event_type TEXT NOT NULL,         -- policy_snapshot / lifecycle_state / tool_call / tool_result / writeback_result / error
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_events_query
  ON agent_runtime_events(user_id, flow_mode, created_at);
