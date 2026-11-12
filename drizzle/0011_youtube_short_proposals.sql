ALTER TABLE shorts_plan_calls
  ALTER COLUMN episode_id DROP NOT NULL,
  ALTER COLUMN media_revision_id DROP NOT NULL,
  ADD COLUMN youtube_video_id text CHECK (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  ADD COLUMN youtube_start_seconds integer CHECK (youtube_start_seconds BETWEEN 0 AND 86400),
  ADD CONSTRAINT shorts_plan_source_check CHECK (
    (episode_id IS NOT NULL AND media_revision_id IS NOT NULL
      AND youtube_video_id IS NULL AND youtube_start_seconds IS NULL)
    OR (episode_id IS NULL AND media_revision_id IS NULL
      AND youtube_video_id IS NOT NULL AND youtube_start_seconds IS NOT NULL)
  );
