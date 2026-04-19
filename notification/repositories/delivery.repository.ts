import { Pool } from 'pg'
import { logger } from '../lib/logger'

// ─────────────────────────────────────────────────────────────
// Delivery repository
//
// Provides typed, single-purpose functions for updating delivery
// rows. The WS gateway only writes — it never queries — so this
// interface is intentionally narrow.
//
// Schema (written by the fan-out service before enqueuing):
//   CREATE TABLE deliveries (
//     id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
//     event_id     UUID         NOT NULL,
//     user_id      UUID         NOT NULL,
//     tenant_id    UUID         NOT NULL,
//     channel      TEXT         NOT NULL CHECK (channel IN ('websocket','webhook','push')),
//     status       TEXT         NOT NULL DEFAULT 'pending'
//                              CHECK (status IN ('pending','sent','failed','deduped','cancelled')),
//     bull_job_id  TEXT,
//     error        TEXT,
//     sent_at      TIMESTAMPTZ,
//     created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
//     updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
//     UNIQUE (event_id, user_id, channel)   -- dedup constraint of last resort
//   );
//
// Three-state idempotency:
//   pending  → delivery has not been attempted yet
//   sent     → notification reached the client (socket write confirmed)
//   failed   → all attempts exhausted; operator can requeue from DLQ
//   deduped  → Redis pre-check determined this was already sent
//
// The Redis dedup key is the primary guard. The DB UNIQUE constraint
// on (event_id, user_id, channel) is the last-resort guard if Redis
// is temporarily unavailable and both a job and its retry try to
// insert a delivery record simultaneously.
// ─────────────────────────────────────────────────────────────

// Module-level pool — initialised lazily on first use so that
// tests can set DATABASE_URL before any repository method is called.
let _pool: Pool | null = null

function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env['DATABASE_URL']
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set')
    }
    _pool = new Pool({
      connectionString,
      max:                     10,
      idleTimeoutMillis:       30_000,
      connectionTimeoutMillis: 5_000,
    })
    _pool.on('error', err => {
      logger.error({ err }, 'Unexpected error on idle DB client')
    })
  }
  return _pool
}

export async function disconnectPool(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}

// ─────────────────────────────────────────────────────────────
// Repository methods
// ─────────────────────────────────────────────────────────────

export const deliveryRepository = {
  /**
   * Mark a delivery as successfully sent to the client's socket.
   * Sets status='sent' and records the wall-clock send time.
   */
  async markSent(deliveryId: string): Promise<void> {
    await getPool().query(
      `UPDATE deliveries
          SET status     = 'sent',
              sent_at    = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND status NOT IN ('sent', 'deduped')`,
      [deliveryId],
    )
  },

  /**
   * Mark a delivery as failed.
   * Records the failure reason for DLQ inspection.
   */
  async markFailed(deliveryId: string, reason: string): Promise<void> {
    await getPool().query(
      `UPDATE deliveries
          SET status     = 'failed',
              error      = $2,
              updated_at = NOW()
        WHERE id = $1
          AND status NOT IN ('sent', 'failed', 'deduped')`,
      [deliveryId, reason],
    )
  },

  /**
   * Mark a delivery as deduped — the Redis dedup key indicated
   * this notification was already sent within the last 24 h.
   */
  async markDeduped(deliveryId: string): Promise<void> {
    await getPool().query(
      `UPDATE deliveries
          SET status     = 'deduped',
              updated_at = NOW()
        WHERE id = $1
          AND status = 'pending'`,
      [deliveryId],
    )
  },
}
