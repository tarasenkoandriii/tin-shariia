ALTER TABLE youtube_comment_settings
  DROP CONSTRAINT youtube_comment_settings_interval_hours_check,
  ADD CONSTRAINT youtube_comment_settings_interval_hours_check CHECK (interval_hours BETWEEN 1 AND 168),
  ALTER COLUMN interval_hours SET DEFAULT 1;

UPDATE youtube_comment_settings SET interval_hours=1, updated_at=now() WHERE id=1;
