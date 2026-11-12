CREATE TABLE episode_media_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL,
  episode_version integer NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES members(id),
  ordinal integer NOT NULL CHECK (ordinal>0),
  pathname text NOT NULL UNIQUE,
  expected_bytes integer NOT NULL CHECK (expected_bytes>0),
  upload_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','queued','checking','passed','failed','expired')),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  ffmpeg_id uuid UNIQUE,
  report jsonb,
  error_code text,
  run_lease timestamptz,
  run_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id,ordinal),
  FOREIGN KEY (episode_id,episode_version) REFERENCES episode_versions(episode_id,version)
);
CREATE INDEX episode_media_active ON episode_media_revisions(created_at) WHERE state IN ('queued','checking');
