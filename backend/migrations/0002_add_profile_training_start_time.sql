-- Add daily training start time (HH:mm) to user_profiles
ALTER TABLE user_profiles ADD COLUMN training_start_time TEXT;
