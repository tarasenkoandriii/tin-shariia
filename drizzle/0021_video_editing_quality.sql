ALTER TABLE prepublication_audits
  ADD COLUMN editing_score smallint CHECK (editing_score BETWEEN 0 AND 100),
  ADD COLUMN editing_rationale text,
  ADD CONSTRAINT prepublication_audit_editing_pair CHECK ((editing_score IS NULL) = (editing_rationale IS NULL));
