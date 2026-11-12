CREATE TABLE videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id text NOT NULL UNIQUE CHECK (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id),
  version integer NOT NULL CHECK (version > 0),
  format text NOT NULL CHECK (format IN ('txt', 'srt', 'vtt')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, version),
  UNIQUE (video_id, content_hash)
);

CREATE TABLE transcript_segments (
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  start_ms bigint,
  end_ms bigint,
  body text NOT NULL CHECK (length(body) > 0),
  PRIMARY KEY (transcript_id, position),
  CHECK (
    (start_ms IS NULL AND end_ms IS NULL)
    OR (start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms >= 0 AND end_ms > start_ms)
  )
);
