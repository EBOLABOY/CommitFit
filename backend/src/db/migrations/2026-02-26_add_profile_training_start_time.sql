-- 新增身体数据字段：每日训练开始时间（24小时制 HH:mm）
ALTER TABLE user_profiles ADD COLUMN training_start_time TEXT;
