ALTER TABLE ai_jobs ALTER COLUMN transcript_id DROP NOT NULL;
ALTER TABLE ai_jobs ADD COLUMN mode text NOT NULL DEFAULT 'transcript';
ALTER TABLE ai_jobs ADD COLUMN media_revision_id uuid REFERENCES episode_media_revisions(id);
ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_source CHECK (
  (mode='transcript' AND transcript_id IS NOT NULL AND media_revision_id IS NULL)
  OR (mode='video' AND transcript_id IS NULL AND media_revision_id IS NOT NULL)
);
ALTER TABLE ai_chunks ADD COLUMN provider_state jsonb;
ALTER TABLE ai_chunks ADD COLUMN provider_cleaned_at timestamptz;
CREATE INDEX ai_jobs_media ON ai_jobs(media_revision_id,created_at DESC) WHERE mode='video';

CREATE TABLE prepublication_audits (
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  media_revision_id uuid NOT NULL REFERENCES episode_media_revisions(id),
  coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage)='array'),
  summary text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,attempt),
  FOREIGN KEY (job_id,attempt) REFERENCES ai_attempts(job_id,attempt)
);
CREATE TABLE audit_findings (
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  position integer NOT NULL,
  finding jsonb NOT NULL CHECK (jsonb_typeof(finding)='object'),
  PRIMARY KEY (job_id,attempt,position),
  FOREIGN KEY (job_id,attempt) REFERENCES prepublication_audits(job_id,attempt)
);
