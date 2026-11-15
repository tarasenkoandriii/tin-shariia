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
CREATE TABLE editorial_cycle_media_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cycle_id uuid NOT NULL REFERENCES editorial_cycles(id),
 kind text NOT NULL CHECK(kind IN ('render','youtube_audio')),
 state text NOT NULL DEFAULT 'preparing' CHECK(state IN ('preparing','queued','running','done','failed','unknown')),
 input jsonb NOT NULL DEFAULT '{}',
 output jsonb,
 lease uuid,
 lease_until timestamptz,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(cycle_id,kind)
);
ALTER TABLE editorial_cycles ADD COLUMN workflow_run_id text;
ALTER TABLE editorial_cycles ADD COLUMN dispatch_until timestamptz;
