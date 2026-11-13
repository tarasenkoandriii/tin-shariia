CREATE TABLE publication_youtube_stats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_id uuid REFERENCES publications(id) ON DELETE CASCADE,
  upload_id uuid REFERENCES youtube_short_uploads(id) ON DELETE CASCADE,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  channel_id text,
  title text,
  description text,
  views bigint CHECK (views IS NULL OR views >= 0),
  likes bigint CHECK (likes IS NULL OR likes >= 0),
  comments bigint CHECK (comments IS NULL OR comments >= 0),
  error_code text,
  CHECK ((publication_id IS NULL) <> (upload_id IS NULL))
);
CREATE INDEX publication_youtube_stats_latest ON publication_youtube_stats(publication_id,fetched_at DESC);
CREATE INDEX youtube_short_stats_latest ON publication_youtube_stats(upload_id,fetched_at DESC);

CREATE TABLE episode_grok_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  episode_version integer NOT NULL,
  round integer NOT NULL CHECK (round > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','submitting','submitted','succeeded','accepted','failed','unknown')),
  batch_id text,
  batch_request_id text NOT NULL UNIQUE CHECK (batch_request_id ~ '^[a-f0-9-]{36}$'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot)='object'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  error_code text,
  reserved_micros integer NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  accepted_by uuid REFERENCES members(id),
  accepted_at timestamptz,
  auto_accepted boolean NOT NULL DEFAULT false,
  auto_accept_threshold smallint CHECK (auto_accept_threshold IS NULL OR auto_accept_threshold BETWEEN 0 AND 100),
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(episode_id,episode_version,round),
  FOREIGN KEY (episode_id,episode_version) REFERENCES episode_versions(episode_id,version)
);
CREATE INDEX episode_grok_reviews_pending ON episode_grok_reviews(state,updated_at);
CREATE INDEX episode_grok_reviews_latest ON episode_grok_reviews(episode_id,episode_version,round DESC);

CREATE TABLE editorial_ai_settings (
  id integer PRIMARY KEY CHECK (id=1),
  auto_accept_score smallint NOT NULL DEFAULT 80 CHECK (auto_accept_score BETWEEN 0 AND 100),
  updated_by uuid REFERENCES members(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO editorial_ai_settings(id,auto_accept_score) VALUES(1,80);

CREATE TABLE editorial_ai_setting_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES members(id),
  old_auto_accept_score smallint NOT NULL,
  new_auto_accept_score smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
