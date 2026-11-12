CREATE TABLE youtube_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youtube_oauth_state_expiry ON youtube_oauth_states(expires_at);

CREATE TABLE youtube_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES members(id),
  channel_id text NOT NULL,
  channel_title text NOT NULL,
  refresh_token_encrypted text,
  scopes text[] NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX youtube_one_active_connection ON youtube_connections((true)) WHERE disconnected_at IS NULL;

CREATE TABLE youtube_short_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES episodes(id),
  media_revision_id uuid NOT NULL UNIQUE REFERENCES episode_media_revisions(id),
  connection_id uuid NOT NULL REFERENCES youtube_connections(id),
  created_by uuid NOT NULL REFERENCES members(id),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^[a-f0-9-]{36}$'),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (length(description) <= 5000),
  privacy_status text NOT NULL CHECK (privacy_status IN ('private','unlisted','public')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','uploading','processing','published','failed','unknown')),
  upload_uri_encrypted text,
  upload_offset bigint NOT NULL DEFAULT 0 CHECK (upload_offset >= 0),
  total_bytes bigint NOT NULL CHECK (total_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  youtube_id text UNIQUE CHECK (youtube_id IS NULL OR youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  processing_status text,
  actual_privacy_status text CHECK (actual_privacy_status IS NULL OR actual_privacy_status IN ('private','unlisted','public')),
  error_code text,
  run_lease timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youtube_upload_active ON youtube_short_uploads(updated_at)
  WHERE state IN ('queued','uploading','processing','unknown');

CREATE TABLE youtube_upload_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES youtube_short_uploads(id),
  actor_id uuid REFERENCES members(id),
  action text NOT NULL CHECK (action IN ('queued','session_started','chunk_accepted','processing','published','failed','unknown','disconnected')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youtube_upload_event_history ON youtube_upload_events(upload_id,id DESC);

