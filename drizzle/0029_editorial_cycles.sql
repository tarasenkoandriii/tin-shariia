CREATE TABLE editorial_cycles (
 id uuid PRIMARY KEY,
 created_by uuid NOT NULL REFERENCES members(id),
 state text NOT NULL CHECK (state IN ('queued','running','waiting','completed','skipped','unknown','blocked')),
 stage_index integer NOT NULL DEFAULT 0 CHECK(stage_index BETWEEN 0 AND 10),
 policy jsonb NOT NULL,
 artifacts jsonb NOT NULL DEFAULT '{}',
 events jsonb NOT NULL DEFAULT '[]',
 release_state text,
 youtube_id text,
 promotion_state text,
 code text,
 lease uuid,
 lease_until timestamptz,
 retry_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX editorial_cycles_queue ON editorial_cycles(state,retry_at,updated_at);
-- Two active cycles must not spend money on the same source in parallel.
CREATE UNIQUE INDEX editorial_cycles_active_source ON editorial_cycles
 ((artifacts->'discover'->>'videoId'))
 WHERE state IN ('queued','running','waiting') AND artifacts->'discover'->>'videoId' IS NOT NULL;
