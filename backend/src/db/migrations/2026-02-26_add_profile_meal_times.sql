-- 新增身体数据字段：三餐时间（24小时制 HH:mm）
ALTER TABLE user_profiles ADD COLUMN breakfast_time TEXT;
ALTER TABLE user_profiles ADD COLUMN lunch_time TEXT;
ALTER TABLE user_profiles ADD COLUMN dinner_time TEXT;
