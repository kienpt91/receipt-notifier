-- Payment side (owned by the App API / App worker).
CREATE TABLE payments (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT        NOT NULL,              -- 'whop' | 'manual'
  provider_payment_id TEXT        NOT NULL,              -- e.g. Whop 'pay_...'
  customer_email      TEXT,                              -- Whop may omit it (missing scope)
  amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status              TEXT        NOT NULL,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);

-- Durable dedupe of provider webhook deliveries (Whop retries reuse webhook-id).
-- Redis is only a fast path in front of this; this table is the source of truth.
CREATE TABLE webhook_events (
  provider    TEXT        NOT NULL,
  event_id    TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Transactional outbox: written in the SAME transaction as the payment row,
-- then published to Kafka by the relay. Fixes the DB + Kafka dual-write.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT        NOT NULL,
  message_key  TEXT        NOT NULL,
  dedupe_key   TEXT        NOT NULL UNIQUE,
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- Notification side (would live in the notification service's own DB in production).
CREATE TABLE email_deliveries (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT        NOT NULL,
  payment_reference   TEXT        NOT NULL,
  recipient           TEXT        NOT NULL,
  amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts            INT         NOT NULL DEFAULT 0,
  max_attempts        INT         NOT NULL DEFAULT 8,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by           TEXT,
  locked_until        TIMESTAMPTZ,
  last_error          TEXT,
  provider_message_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  UNIQUE (provider, payment_reference),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX email_deliveries_due ON email_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'sending');

-- Messages the consumer could not accept. Never silently dropped.
CREATE TABLE dead_letters (
  id          BIGSERIAL PRIMARY KEY,
  topic       TEXT        NOT NULL,
  message_key TEXT,
  value       TEXT,
  error       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
