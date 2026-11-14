CREATE TABLE captions_import_jobs (
  video_id uuid PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,
  lease_until timestamptz,
  error_code text,
  transcript_version integer
);
