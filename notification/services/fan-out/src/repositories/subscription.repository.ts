import { Pool } from 'pg'

// ─────────────────────────────────────────────────────────────────
// Subscription repository — read-only, used by the fan-out worker
//
// A subscription is a (tenant, user, eventType, channel) record
// that says "deliver events of this type to this user on this channel".
//
// event_type = '*' is a wildcard: the user receives every event
// from that tenant, regardless of type. Fan-out runs two queries:
//   1. Exact match:    (tenantId, eventType, channel)
//   2. Wildcard match: (tenantId, '*', channel)
// Then deduplicates by userId before creating deliveries.
// ─────────────────────────────────────────────────────────────────

export interface Subscription {
  userId:    string
  tenantId:  string
  channel:   'websocket' | 'webhook' | 'push'
}

export interface WebhookSubscription extends Subscription {
  channel:     'webhook'
  webhookId:   string
  endpointUrl: string
  secretId:    string
}

let _pool: Pool | null = null

function getPool(): Pool {
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
 * Returns all active WebSocket subscribers for a (tenantId, eventType).
 * Includes wildcard ('*') subscriptions.
 * Deduplicates by userId — a user can only have one WS subscription per tenant.
 */
export async function getWsSubscribers(
  tenantId:  string,
  eventType: string,
): Promise<Pick<Subscription, 'userId'>[]> {
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT user_id
       FROM subscriptions
      WHERE tenant_id = $1
        AND event_type IN ($2, '*')
        AND channel    = 'websocket'
        AND is_active  = TRUE`,
    [tenantId, eventType],
  )
  return rows.map(r => ({ userId: r.user_id }))
}

/**
 * Returns all active webhook configurations for a (tenantId, eventType).
 * Includes webhooks with empty event_types array (receives all types).
 */
export async function getWebhookSubscribers(
  tenantId:  string,
  eventType: string,
): Promise<WebhookSubscription[]> {
  // A webhook fires if:
  //   - event_types is empty (wildcard), OR
  //   - event_types contains the specific eventType
  const { rows } = await getPool().query<{
    webhook_id:   string
    endpoint_url: string
    secret_id:    string
  }>(
    `SELECT w.id          AS webhook_id,
            w.endpoint_url,
            w.secret_id
       FROM webhooks w
      WHERE w.tenant_id  = $1
        AND w.is_active   = TRUE
        AND (
          w.event_types = '{}'
          OR $2 = ANY(w.event_types)
        )`,
    [tenantId, eventType],
  )

  return rows.map(r => ({
    userId:      tenantId,   // webhook delivery is tenant-scoped, not user-scoped
    tenantId,
    channel:     'webhook' as const,
    webhookId:   r.webhook_id,
    endpointUrl: r.endpoint_url,
    secretId:    r.secret_id,
  }))
}
