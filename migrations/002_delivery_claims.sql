-- attempts counted lease pickups, so unrelated worker crashes could exhaust a receipt's
-- attempts before it was ever sent. Split them:
--   claims   - every pickup (crash recovery included); only guards against poison rows
--   attempts - real provider calls; drives backoff and max_attempts
-- first_attempt_at bounds automatic resends to the provider's idempotency window.
ALTER TABLE email_deliveries
  ADD COLUMN claims INT NOT NULL DEFAULT 0,
  ADD COLUMN first_attempt_at TIMESTAMPTZ;
