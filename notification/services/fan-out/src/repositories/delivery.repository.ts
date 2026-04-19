import { Pool, PoolClient } from 'pg'

// ─────────────────────────────────────────────────────────────────
// Delivery repository — write-only, used by the fan-out worker
//
// The fan-out worker creates delivery rows before enqueuing the
// channel-specific job. This ordering guarantees:
//   - The delivery row always exists when the channel worker runs
//   - BullMQ retries can safely re-attempt the same job ID
//   - A crash between INSERT and Queue.add leaves a 'pending' row
//     that an operator can requeue from a DLQ
//
// See delivery.repository.ts in ws-gateway for the read side.
// ─────────────────────────────────────────────────────────────────

export interface CreateDeliveryParams {
  eventId:  string
  userId:   string
  tenantId: string
  channel:  'websocket' | 'webhook' | 'push'
}

let _pool: Pool | null = null

export function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env['DATABASE_URL']
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    _pool = new Pool({ connectionString, max: 5 })
    _pool.on('error', err => console.error('[fan-out] Idle DB client error', err))
  }
  return _pool
}

export async function disconnectPool(): Promise<void> {
  if (_pool) { await _pool.end(); _pool = null }
}

/**
 * Inserts a delivery row with status='pending'.
 * ON CONFLICT DO NOTHING — if the fan-out job is retried, duplicate
 * delivery rows are silently skipped. The existing row's status is
 * preserved so we don't reset a 'sent' delivery back to 'pending'.
 *
 * Returns the delivery id so the caller can store it in the BullMQ job.
 */
export async function createDelivery(
  params: CreateDeliveryParams,
  client?: PoolClient,
): Promise<string | null> {
  const executor = client ?? getPool()
  const { rows } = await executor.query<{ id: string }>(
    `INSERT INTO deliveries (event_id, user_id, tenant_id, channel, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (event_id, user_id, channel) DO NOTHING
     RETURNING id`,
    [params.eventId, params.userId, params.tenantId, params.channel],
  )
  // ON CONFLICT DO NOTHING returns no rows — return null to signal skip
  return rows[0]?.id ?? null
}

/**
 * Marks an event as 'processed' after all delivery jobs are enqueued.
 * If any channel fails, the event stays 'processing' and an operator
 * can inspect / requeue from a monitoring tool.
 */
export async function markEventProcessed(
  tenantId: string,
  eventId:  string,
): Promise<void> {
  await getPool().query(
    `UPDATE events
        SET status     = 'processed',
            updated_at = NOW()
      WHERE tenant_id = $1
        AND event_id  = $2
        AND status    = 'processing'`,
    [tenantId, eventId],
  )
}

/**
 * Marks an event as 'failed' with an error message for operator visibility.
 */
export async function markEventFailed(
  tenantId: string,
  eventId:  string,
  error:    string,
): Promise<void> {
  await getPool().query(
    `UPDATE events
        SET status     = 'failed',
            error      = $3,
            updated_at = NOW()
      WHERE tenant_id = $1
        AND event_id  = $2`,
    [tenantId, eventId, error],
  )
}
