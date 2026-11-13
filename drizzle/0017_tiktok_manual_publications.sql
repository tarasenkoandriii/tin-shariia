CREATE TABLE tiktok_short_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id uuid NOT NULL UNIQUE REFERENCES shorts_renders(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES episodes(id),
  episode_version integer NOT NULL,
  media_revision_id uuid NOT NULL REFERENCES episode_media_revisions(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (length(description)<=2000),
  state text NOT NULL DEFAULT 'ready_to_publish' CHECK (state IN ('ready_to_publish','published','failed')),
  tiktok_url text,
  published_at timestamptz,
  ai_disclosed boolean NOT NULL DEFAULT false,
  error_note text,
  created_by uuid NOT NULL REFERENCES members(id),
  updated_by uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='published' AND tiktok_url IS NOT NULL AND published_at IS NOT NULL AND ai_disclosed=true AND error_note IS NULL)
    OR state<>'published'),
  CHECK (state<>'failed' OR error_note IS NOT NULL)
);
CREATE UNIQUE INDEX tiktok_short_publications_url ON tiktok_short_publications(tiktok_url) WHERE tiktok_url IS NOT NULL;
CREATE INDEX tiktok_short_publications_episode ON tiktok_short_publications(episode_id,created_at DESC);

CREATE TABLE tiktok_short_publication_events (
  id bigserial PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES tiktok_short_publications(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES members(id),
  action text NOT NULL CHECK (action IN ('prepared','published','failed','retry_prepared')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
