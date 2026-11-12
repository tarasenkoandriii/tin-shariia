ALTER TABLE episode_media_revisions
  ADD COLUMN kind text NOT NULL DEFAULT 'montage' CHECK (kind IN ('montage','short'));

ALTER TABLE shorts_renders
  DROP CONSTRAINT shorts_renders_state_check,
  ADD CONSTRAINT shorts_renders_state_check CHECK (state IN ('queued','rendering','technical_check','ready','failed','expired')),
  ADD COLUMN audit_ffmpeg_id uuid UNIQUE,
  ADD COLUMN technical_report jsonb CHECK (technical_report IS NULL OR jsonb_typeof(technical_report)='object'),
  ADD COLUMN audit_media_revision_id uuid UNIQUE REFERENCES episode_media_revisions(id);

CREATE INDEX shorts_technical_active ON shorts_renders(created_at)
  WHERE state IN ('queued','rendering','technical_check');
