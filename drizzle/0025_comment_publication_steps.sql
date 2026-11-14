CREATE TABLE youtube_comment_steps (
  comment_id uuid PRIMARY KEY REFERENCES youtube_short_comments(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('waiting_plain','link_ready','link_sending','waiting_link','verified','blocked')),
  plain_text text NOT NULL,
  linked_text text NOT NULL,
  lease uuid,
  lease_until timestamptz,
  plain_verified_at timestamptz,
  linked_verified_at timestamptz,
  checked_at timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
