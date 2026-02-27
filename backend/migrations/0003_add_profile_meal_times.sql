-- Add meal times (HH:mm) to user_profiles
ALTER TABLE user_profiles ADD COLUMN breakfast_time TEXT;
ALTER TABLE user_profiles ADD COLUMN lunch_time TEXT;
ALTER TABLE user_profiles ADD COLUMN dinner_time TEXT;
