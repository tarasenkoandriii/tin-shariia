ALTER TABLE youtube_oauth_states
  ADD COLUMN request_comment_scope boolean NOT NULL DEFAULT false;

CREATE TABLE youtube_comment_settings (
  id integer PRIMARY KEY CHECK (id=1),
  enabled boolean NOT NULL DEFAULT false,
  interval_hours smallint NOT NULL DEFAULT 3 CHECK (interval_hours BETWEEN 3 AND 168),
  updated_by uuid REFERENCES members(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO youtube_comment_settings(id,enabled,interval_hours) VALUES(1,false,3);

CREATE TABLE youtube_short_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL UNIQUE REFERENCES youtube_short_uploads(id) ON DELETE CASCADE,
  parent_video_id text NOT NULL,
  short_video_id text NOT NULL,
  tracking_token text NOT NULL UNIQUE CHECK (tracking_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  batch_request_id uuid NOT NULL UNIQUE,
  batch_id text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','submitting','submitted','succeeded','scheduled','publishing','published','failed','rejected','unknown')),
  draft_text text,
  final_text text,
  input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot)='object'),
  reserved_micros integer NOT NULL DEFAULT 0 CHECK (reserved_micros>=0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  scheduled_at timestamptz,
  lease_until timestamptz,
  youtube_thread_id text,
  youtube_comment_id text,
  published_at timestamptz,
  approved_by uuid REFERENCES members(id),
  approved_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX youtube_short_comments_due ON youtube_short_comments(state,scheduled_at,created_at);
CREATE INDEX youtube_short_comments_episode ON youtube_short_comments(episode_id,published_at DESC);

CREATE TABLE youtube_short_comment_clicks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comment_id uuid NOT NULL REFERENCES youtube_short_comments(id) ON DELETE CASCADE,
  clicked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youtube_short_comment_clicks_time ON youtube_short_comment_clicks(clicked_at DESC);
CREATE INDEX youtube_short_comment_clicks_comment ON youtube_short_comment_clicks(comment_id,clicked_at DESC);

CREATE TABLE youtube_short_comment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comment_id uuid NOT NULL REFERENCES youtube_short_comments(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES members(id),
  action text NOT NULL CHECK (action IN ('drafted','approved','rejected','scheduled','published','failed','unknown')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youtube_short_comment_events_history ON youtube_short_comment_events(comment_id,created_at);
