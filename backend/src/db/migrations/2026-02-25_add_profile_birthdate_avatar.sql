-- 新增用户头像字段
ALTER TABLE users ADD COLUMN avatar_key TEXT;

-- 新增身体数据字段：出生年月日、训练年限
ALTER TABLE user_profiles ADD COLUMN birth_date TEXT;
ALTER TABLE user_profiles ADD COLUMN training_years REAL;
