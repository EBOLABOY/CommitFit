-- Add metadata column to chat_history for storing routing/supplement info
ALTER TABLE chat_history ADD COLUMN metadata TEXT;
