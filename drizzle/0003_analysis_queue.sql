CREATE TABLE ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id),
  transcript_id uuid NOT NULL REFERENCES transcripts(id),
  requested_by uuid NOT NULL REFERENCES members(id),
  dedupe_key text NOT NULL UNIQUE,
  model text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','unknown')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_jobs_active ON ai_jobs(requested_by) WHERE status IN ('queued','running');
CREATE INDEX ai_jobs_video ON ai_jobs(video_id,created_at DESC);

CREATE TABLE ai_attempts (
  job_id uuid NOT NULL REFERENCES ai_jobs(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','unknown')),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,attempt)
);

CREATE TABLE budget_reservations (
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  month date NOT NULL,
  reserved_micros bigint NOT NULL CHECK (reserved_micros > 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  status text NOT NULL CHECK (status IN ('held','settled','unknown')),
  PRIMARY KEY (job_id,attempt),
  FOREIGN KEY (job_id,attempt) REFERENCES ai_attempts(job_id,attempt)
);
CREATE INDEX budget_reservations_month ON budget_reservations(month);

CREATE TABLE job_outbox (
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  workflow_run_id text,
  finished_at timestamptz,
  PRIMARY KEY (job_id,attempt),
  FOREIGN KEY (job_id,attempt) REFERENCES ai_attempts(job_id,attempt)
);

CREATE TABLE ai_chunks (
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  position integer NOT NULL,
  input jsonb NOT NULL,
  result jsonb,
  usage jsonb,
  input_rate integer NOT NULL CHECK (input_rate > 0),
  output_rate integer NOT NULL CHECK (output_rate > 0),
  retries integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','complete')),
  PRIMARY KEY (job_id,attempt,position),
  FOREIGN KEY (job_id,attempt) REFERENCES ai_attempts(job_id,attempt)
);

CREATE TABLE ai_claim_drafts (
  job_id uuid NOT NULL REFERENCES ai_jobs(id),
  position integer NOT NULL,
  draft jsonb NOT NULL,
  PRIMARY KEY (job_id,position)
);
