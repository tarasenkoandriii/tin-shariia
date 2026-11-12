CREATE TABLE soniox_requests (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX soniox_requests_created ON soniox_requests(created_at);
