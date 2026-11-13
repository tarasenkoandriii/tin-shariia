ALTER TABLE editorial_ai_settings ALTER COLUMN auto_accept_score SET DEFAULT 75;
UPDATE editorial_ai_settings SET auto_accept_score=75 WHERE id=1;
