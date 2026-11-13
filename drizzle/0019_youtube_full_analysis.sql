-- Whole-video Gemini analysis of a public YouTube video, claims from its drafts, Gemini scenario drafts.
ALTER TABLE ai_jobs DROP CONSTRAINT ai_jobs_source;
ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_source CHECK (
  (mode='transcript' AND transcript_id IS NOT NULL AND media_revision_id IS NULL)
  OR (mode='video' AND transcript_id IS NULL AND media_revision_id IS NOT NULL)
  OR (mode='youtube' AND transcript_id IS NULL AND media_revision_id IS NULL)
);

-- A draft becomes at most one claim; claiming_at fences concurrent clicks.
ALTER TABLE ai_claim_drafts ADD COLUMN claim_id uuid REFERENCES claims(id);
ALTER TABLE ai_claim_drafts ADD COLUMN claiming_at timestamptz;
CREATE UNIQUE INDEX ai_claim_drafts_claim ON ai_claim_drafts(claim_id) WHERE claim_id IS NOT NULL;

CREATE TABLE scenario_ai_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES claims(id),
  claim_version integer NOT NULL CHECK (claim_version > 0),
  requested_by uuid NOT NULL REFERENCES members(id),
  request_key uuid NOT NULL UNIQUE,
  month date NOT NULL,
  model text NOT NULL,
  reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed','unknown')),
  error_code text,
  episode_id uuid REFERENCES episodes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX scenario_ai_calls_month ON scenario_ai_calls(month);
