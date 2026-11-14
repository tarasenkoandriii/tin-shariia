-- Editor-approved YouTube abuse reports prepared from an approved fact-check.
CREATE TABLE youtube_abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES claims(id),
  claim_version integer NOT NULL,
  video_id uuid NOT NULL REFERENCES videos(id),
  source_youtube_id text NOT NULL CHECK (source_youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  source_channel_id text CHECK (source_channel_id IS NULL OR source_channel_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  source_channel_title text NOT NULL DEFAULT '' CHECK (length(source_channel_title) <= 300),
  policy_basis text NOT NULL DEFAULT '' CHECK (length(policy_basis) <= 32),
  policy_note text NOT NULL DEFAULT '' CHECK (length(policy_note) <= 2000),
  comments text NOT NULL DEFAULT '' CHECK (length(comments) <= 3000),
  reason_id text CHECK (reason_id IS NULL OR reason_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  secondary_reason_id text CHECK (secondary_reason_id IS NULL OR secondary_reason_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  reason_label text NOT NULL DEFAULT '' CHECK (length(reason_label) <= 300),
  language text NOT NULL DEFAULT 'uk' CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','confirmed','sending','accepted','rejected','unknown')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmation_hash text CHECK (confirmation_hash IS NULL OR confirmation_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by uuid REFERENCES members(id),
  confirmed_at timestamptz,
  connection_id uuid REFERENCES youtube_connections(id),
  reporter_channel_id text,
  sent_by uuid REFERENCES members(id),
  sent_at timestamptz,
  completed_at timestamptz,
  http_status smallint,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  created_by uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, claim_version) REFERENCES claim_versions(claim_id, version),
  CHECK (state NOT IN ('sending','accepted','unknown') OR (reporter_channel_id IS NOT NULL AND sent_at IS NOT NULL))
);
-- One working draft per claim.
CREATE UNIQUE INDEX youtube_abuse_reports_open_claim ON youtube_abuse_reports(claim_id)
  WHERE state IN ('draft','confirmed','rejected');
-- One report per video per connected account: a send in flight, an accepted report, or an
-- unknown outcome blocks every further attempt until a person checks it.
CREATE UNIQUE INDEX youtube_abuse_reports_one_per_account ON youtube_abuse_reports(source_youtube_id, reporter_channel_id)
  WHERE state IN ('sending','accepted','unknown');
CREATE INDEX youtube_abuse_reports_video ON youtube_abuse_reports(video_id, updated_at DESC);

CREATE TABLE youtube_abuse_report_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES youtube_abuse_reports(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES members(id),
  action text NOT NULL CHECK (action IN ('drafted','edited','confirmed','sending','accepted','rejected','unknown')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youtube_abuse_report_events_history ON youtube_abuse_report_events(report_id, created_at);
