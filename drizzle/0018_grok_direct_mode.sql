-- Grok preflight: direct chat-completions call by default, Batch API stays selectable.
ALTER TABLE editorial_ai_settings
  ADD COLUMN grok_mode text NOT NULL DEFAULT 'direct' CHECK (grok_mode IN ('direct','batch'));
UPDATE editorial_ai_settings SET grok_mode='direct' WHERE id=1;

ALTER TABLE editorial_ai_setting_events
  ADD COLUMN old_grok_mode text CHECK (old_grok_mode IS NULL OR old_grok_mode IN ('direct','batch')),
  ADD COLUMN new_grok_mode text CHECK (new_grok_mode IS NULL OR new_grok_mode IN ('direct','batch'));

-- Existing rows were all created for the Batch API; new rows record the mode chosen at queue time.
ALTER TABLE episode_grok_reviews
  ADD COLUMN mode text NOT NULL DEFAULT 'batch' CHECK (mode IN ('direct','batch'));
-- Not yet sent anywhere: switch them to the new default so they do not wait for a batch.
UPDATE episode_grok_reviews SET mode='direct' WHERE state='queued' AND batch_id IS NULL;
CREATE INDEX episode_grok_reviews_direct_queue ON episode_grok_reviews(created_at) WHERE state='queued' AND mode='direct';
