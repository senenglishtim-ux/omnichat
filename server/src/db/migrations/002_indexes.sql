-- Inbox list computes last inbound/outbound time per conversation.
CREATE INDEX IF NOT EXISTS messages_conv_dir_idx ON messages (conversation_id, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_assigned_idx ON conversations (assigned_user_id) WHERE assigned_user_id IS NOT NULL;
