-- Lets operators mark a dead letter as handled so the purge job (npm run purge) can delete
-- it. Unresolved dead letters are never purged: someone still has to look at them.
--   UPDATE dead_letters SET resolved_at = now() WHERE id = <id>;
ALTER TABLE dead_letters ADD COLUMN resolved_at TIMESTAMPTZ;
