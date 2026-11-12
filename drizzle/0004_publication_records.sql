CREATE TABLE publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL UNIQUE,
  episode_version integer NOT NULL,
  youtube_id text NOT NULL UNIQUE CHECK (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  published_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES members(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  FOREIGN KEY (episode_id,episode_version) REFERENCES episode_versions(episode_id,version)
);

CREATE TABLE metric_snapshots (
  publication_id uuid NOT NULL REFERENCES publications(id),
  day integer NOT NULL CHECK (day IN (7,28)),
  measured_at timestamptz NOT NULL,
  views bigint NOT NULL CHECK (views>=0),
  average_view_percent numeric(8,3) NOT NULL CHECK (average_view_percent>=0),
  source text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES members(id),
  PRIMARY KEY (publication_id,day)
);

CREATE TABLE corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES publications(id),
  created_by uuid NOT NULL REFERENCES members(id),
  kind text NOT NULL CHECK (kind IN ('quote','context','fact','translation','metadata','other')),
  original text NOT NULL,
  replacement text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'review' CHECK (status IN ('review','approved','returned','posted')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  review_comment text,
  posting_location text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publication_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES publications(id),
  correction_id uuid REFERENCES corrections(id),
  actor_id uuid NOT NULL REFERENCES members(id),
  action text NOT NULL CHECK (action IN ('register','metrics','propose','approve','return','post')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX publication_events_history ON publication_events(publication_id,id DESC);
CREATE INDEX corrections_publication ON corrections(publication_id);
