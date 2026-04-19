-- ─────────────────────────────────────────────────────────────────
-- Notification Engine — Initial Schema
--
-- Run with:
--   psql "$DATABASE_URL" -f db/migrations/001_initial_schema.sql
--
-- Tables:
--   events         — every incoming event; deduplication anchor
--   subscriptions  — (tenant, user, eventType, channel) tuples
--   deliveries     — per-user per-channel delivery record
--   webhooks       — tenant-configured HTTP endpoint definitions
-- ─────────────────────────────────────────────────────────────────

-- Enable uuid extension if not already present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────────
-- events
--
-- Written by the ingestion-api when an event is first accepted.
-- The event_id column is the client-provided idempotency key —
-- guaranteed unique per tenant to prevent double-processing of
-- retried POST /v1/events requests.
--
-- Status flow:
--   received → processing → processed
--                         ↘ failed
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id    TEXT        NOT NULL,
  tenant_id   UUID        NOT NULL,
  event_type  TEXT        NOT NULL,
  payload     JSONB       NOT NULL DEFAULT '{}',
  status      TEXT        NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received', 'processing', 'processed', 'failed')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Client-provided event_id must be unique per tenant.
  -- Global uniqueness would prevent cross-tenant id collisions but
  -- is unnecessarily restrictive — tenants generate their own IDs.
  UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_tenant_type
  ON events (tenant_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_status
  ON events (status, created_at)
  WHERE status IN ('received', 'processing');

-- ─────────────────────────────────────────────────────────────────
-- subscriptions
--
-- Defines which users receive which notifications on which channels.
-- Written by the tenant management plane (not by this service).
-- The fan-out worker reads this table to determine who to notify.
--
-- event_type '*' means "all event types from this tenant" —
-- acts as a wildcard subscription. The fan-out query runs two
-- lookups: exact match + wildcard, then deduplicates.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID        NOT NULL,
  user_id     UUID        NOT NULL,
  event_type  TEXT        NOT NULL,   -- exact type OR '*' for all types
  channel     TEXT        NOT NULL    CHECK (channel IN ('websocket', 'webhook', 'push')),
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, user_id, event_type, channel)
);

-- Primary fan-out lookup: "who subscribes to this event type on this tenant?"
-- Partial index on is_active = TRUE keeps the index small.
CREATE INDEX IF NOT EXISTS idx_subscriptions_fanout
  ON subscriptions (tenant_id, event_type, channel)
  WHERE is_active = TRUE;

-- ─────────────────────────────────────────────────────────────────
-- deliveries
--
-- One row per (event, user, channel) delivery attempt.
-- Created by the fan-out worker before enqueuing the channel job —
-- store-before-enqueue ensures the row exists when the worker runs.
--
-- Status flow:
--   pending → sent      (notification reached the client)
--           → failed    (all retries exhausted)
--           → deduped   (Redis dedup key found — already sent)
--           → cancelled (subscription deactivated before delivery)
--
-- The UNIQUE (event_id, user_id, channel) constraint is the
-- last-resort dedup guard if Redis is temporarily unavailable.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deliveries (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id    TEXT        NOT NULL,   -- matches events.event_id (logical FK)
  user_id     UUID        NOT NULL,
  tenant_id   UUID        NOT NULL,
  channel     TEXT        NOT NULL    CHECK (channel IN ('websocket', 'webhook', 'push')),
  status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'sent', 'failed', 'deduped', 'cancelled')),
  bull_job_id TEXT,                   -- BullMQ job id, set after enqueue
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Last-resort dedup: prevents duplicate delivery records
  UNIQUE (event_id, user_id, channel)
);

-- Operator dashboard: "show me all failed deliveries for this tenant"
CREATE INDEX IF NOT EXISTS idx_deliveries_tenant_status
  ON deliveries (tenant_id, status, created_at DESC);

-- Worker lookup: "has this delivery already been processed?"
CREATE INDEX IF NOT EXISTS idx_deliveries_event_user
  ON deliveries (event_id, user_id, channel);

-- ─────────────────────────────────────────────────────────────────
-- webhooks
--
-- Tenant-configured HTTP endpoints for webhook delivery.
-- Written by the tenant management plane.
--
-- secret_id is a KMS/Secrets Manager key reference — the actual
-- HMAC signing secret is never stored in the database.
--
-- event_types: empty array means "all event types from this tenant".
-- Specific types ['order.shipped', 'order.cancelled'] limit delivery.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhooks (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID        NOT NULL,
  endpoint_url TEXT        NOT NULL,
  event_types  TEXT[]      NOT NULL DEFAULT '{}',   -- {} = all types
  secret_id    TEXT        NOT NULL,                -- KMS key ref, not the secret
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fan-out webhook lookup
CREATE INDEX IF NOT EXISTS idx_webhooks_tenant
  ON webhooks (tenant_id)
  WHERE is_active = TRUE;

-- ─────────────────────────────────────────────────────────────────
-- Seed: a test tenant and subscriptions (development only)
-- Uncomment to populate a local dev environment.
-- ─────────────────────────────────────────────────────────────────

-- INSERT INTO subscriptions (tenant_id, user_id, event_type, channel) VALUES
--   ('00000000-0000-0000-0000-000000000001',
--    '00000000-0000-0000-0000-000000000002',
--    '*', 'websocket')
-- ON CONFLICT DO NOTHING;
