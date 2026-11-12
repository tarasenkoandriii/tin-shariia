CREATE TABLE shorts_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES episodes(id),
  media_revision_id uuid NOT NULL REFERENCES episode_media_revisions(id),
  episode_version integer NOT NULL,
  created_by uuid NOT NULL REFERENCES members(id),
  idempotency_key text NOT NULL UNIQUE,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','rendering','ready','failed','expired')),
  ffmpeg_id uuid UNIQUE,
  pathname text UNIQUE,
  expected_bytes integer CHECK (expected_bytes>0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  error_code text,
  expires_at timestamptz NOT NULL,
  run_token uuid,
  run_lease timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (episode_id,episode_version) REFERENCES episode_versions(episode_id,version)
);
CREATE INDEX shorts_active ON shorts_renders(created_at) WHERE state IN ('queued','rendering');

CREATE TABLE shorts_plan_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES episodes(id),
  media_revision_id uuid NOT NULL REFERENCES episode_media_revisions(id),
  requested_by uuid NOT NULL REFERENCES members(id),
  request_key uuid NOT NULL UNIQUE,
  month date NOT NULL,
  model text NOT NULL,
  reserved_micros bigint NOT NULL CHECK (reserved_micros>0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros>=0),
  state text NOT NULL CHECK (state IN ('running','succeeded','failed','unknown')),
  plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shorts_plan_month ON shorts_plan_calls(month,state);
