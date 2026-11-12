CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id),
  created_by uuid NOT NULL REFERENCES members(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','withdrawn'))
);
CREATE INDEX claims_video ON claims(video_id);

CREATE TABLE claim_versions (
  claim_id uuid NOT NULL REFERENCES claims(id),
  version integer NOT NULL CHECK (version > 0),
  author_id uuid NOT NULL REFERENCES members(id),
  transcript_id uuid REFERENCES transcripts(id),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, version)
);

CREATE TABLE episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES claims(id),
  created_by uuid NOT NULL REFERENCES members(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved'))
);
CREATE INDEX episodes_claim ON episodes(claim_id);

CREATE TABLE episode_versions (
  episode_id uuid NOT NULL REFERENCES episodes(id),
  version integer NOT NULL CHECK (version > 0),
  author_id uuid NOT NULL REFERENCES members(id),
  claim_id uuid NOT NULL,
  claim_version integer NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (episode_id, version),
  FOREIGN KEY (claim_id, claim_version) REFERENCES claim_versions(claim_id, version)
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL UNIQUE,
  title text NOT NULL,
  organization text NOT NULL,
  publication_date date,
  accessed_on date NOT NULL,
  primary_url text
);

CREATE TABLE claim_evidence (
  claim_id uuid NOT NULL,
  claim_version integer NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  source_id uuid NOT NULL REFERENCES sources(id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (claim_id, claim_version, position),
  FOREIGN KEY (claim_id, claim_version) REFERENCES claim_versions(claim_id, version)
);

CREATE TABLE editorial_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id uuid,
  episode_id uuid,
  version integer NOT NULL,
  revision integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES members(id),
  action text NOT NULL CHECK (action IN ('create','edit','submit','approve','return','withdraw')),
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(claim_id, episode_id) = 1),
  FOREIGN KEY (claim_id, version) REFERENCES claim_versions(claim_id, version),
  FOREIGN KEY (episode_id, version) REFERENCES episode_versions(episode_id, version),
  UNIQUE (claim_id, revision),
  UNIQUE (episode_id, revision)
);
CREATE VIEW reviews AS
SELECT * FROM editorial_events WHERE action IN ('approve','return');
