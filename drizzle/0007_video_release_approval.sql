ALTER TABLE prepublication_audits
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES members(id);

ALTER TABLE publications
  ADD COLUMN media_revision_id uuid REFERENCES episode_media_revisions(id);

CREATE TABLE audit_finding_reviews (
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  position integer NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('resolved','accepted')),
  comment text NOT NULL CHECK (length(trim(comment)) BETWEEN 1 AND 4000),
  reviewed_by uuid NOT NULL REFERENCES members(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,attempt,position),
  FOREIGN KEY(job_id,attempt,position) REFERENCES audit_findings(job_id,attempt,position)
);
