CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE member_roles (
  member_id uuid NOT NULL REFERENCES members(id),
  role text NOT NULL CHECK (role IN ('author','factchecker','editor','publisher','admin')),
  PRIMARY KEY (member_id, role)
);

CREATE TABLE invitations (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  email text NOT NULL CHECK (email = lower(email)),
  roles text[] NOT NULL CHECK (
    cardinality(roles) BETWEEN 1 AND 5
    AND array_position(roles, NULL) IS NULL
    AND roles <@ ARRAY['author','factchecker','editor','publisher','admin']
  ),
  invited_by uuid NOT NULL REFERENCES members(id),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES members(id),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX invitations_pending_email ON invitations (email)
  WHERE accepted_by IS NULL AND revoked_at IS NULL;

CREATE TABLE access_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('bootstrap','invite','accept','roles','revoke','cancel')),
  actor_id uuid NOT NULL REFERENCES members(id),
  member_id uuid REFERENCES members(id),
  invitation_hash text REFERENCES invitations(token_hash),
  roles text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
