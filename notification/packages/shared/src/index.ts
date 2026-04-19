/**
 * @notification-engine/shared
 *
 * Shared types, constants, schemas, and runtime utilities used by
 * every service in the notification engine monorepo:
 *   - ingestion-api   — receives events, validates, enqueues fan-out jobs
 *   - fan-out         — queries subscriptions, creates deliveries, routes by channel
 *   - ws-gateway      — serves WebSocket connections, delivers notifications
 *   - webhook-service — makes signed HTTP POST calls to tenant-configured URLs
 *
 * Nothing in this package is service-specific. Services import from here;
 * this package never imports from services.
 */

// ─────────────────────────────────────────────────────────────
// External dependencies (installed once at the workspace root)
// ─────────────────────────────────────────────────────────────
import IORedis, { type Redis, type RedisOptions } from 'ioredis'
import { z } from 'zod'
import * as dotenv from 'dotenv'

// ═════════════════════════════════════════════════════════════
// 1. Job payload types
//    These are the shapes serialised into BullMQ job.data.
//    Keep them lean — no nested objects that can't be JSON-round-
//    tripped — and versioned via a `_v` discriminant if the shape
//    ever needs to change with live workers still running.
// ═════════════════════════════════════════════════════════════

export interface FanOutJobPayload {
  eventId:   string    // UUID — the event that triggered fan-out
  tenantId:  string    // UUID
  eventType: string    // e.g. "order.shipped"
  payload:   Record<string, unknown>
}

export interface WsDeliveryJobPayload {
  deliveryId: string   // UUID — the deliveries row this job creates/updates
  eventId:    string   // UUID — back-reference to the source event
  userId:     string   // UUID — recipient
  tenantId:   string   // UUID
  payload:    Record<string, unknown>   // event payload forwarded verbatim
}

export interface WebhookDeliveryJobPayload {
  deliveryId:  string   // UUID
  eventId:     string   // UUID
  tenantId:    string   // UUID
  webhookId:   string   // UUID — the webhook configuration row
  endpointUrl: string   // resolved at fan-out time (snapshot, not re-fetched)
  secretId:    string   // KMS/Secrets Manager key reference for HMAC signing
  payload:     Record<string, unknown>
}

// ═════════════════════════════════════════════════════════════
// 2. Queue names
//    Single source of truth — every service uses these constants.
//    Changing a queue name here is a breaking change; rename with
//    a migration period if workers are deployed independently.
// ═════════════════════════════════════════════════════════════

export const QUEUES = {
  FAN_OUT:          'notification:fan-out',
  WS_DELIVERY:      'notification:ws-delivery',
  WEBHOOK_DELIVERY: 'notification:webhook-delivery',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

// ═════════════════════════════════════════════════════════════
// 3. Redis key patterns
//    Centralised here so key format changes don't require grep-
//    and-replace across services.
// ═════════════════════════════════════════════════════════════

export const RedisKeys = {
  /**
   * Deduplication key for a (event, user, channel) triple.
   * Set for 24 h after a notification is successfully delivered.
   * TTL chosen to be longer than any realistic retry window.
   */
  dedup: (eventId: string, userId: string, channel: string): string =>
    `dedup:${channel}:${eventId}:${userId}`,

  /**
   * Idempotency key for ingestion — prevents double-processing
   * of events submitted with the same idempotency header.
   *   Three states (none | processing | done):
   *   - Key absent  → first time we see this eventId
   *   - Key = "1"   → another process is currently handling it
   *   - Key = "ok"  → already successfully processed; skip
   */
  ingestionIdempotency: (eventId: string): string =>
    `ingest:idem:${eventId}`,

  /**
   * Per-node WebSocket connection presence (Phase 2).
   * Value = serialised connection metadata (nodeId, connectedAt).
   * Used by the fan-out service to route delivery jobs to the
   * correct gateway node.
   */
  wsConn: (tenantId: string, userId: string): string =>
    `ws:conn:${tenantId}:${userId}`,

  /**
   * Webhook circuit-breaker failure counter.
   * Incremented on each failed HTTP attempt; reset on success.
   * When count ≥ threshold, the circuit opens and deliveries
   * are rejected immediately without an outbound HTTP call.
   */
  circuitBreaker: (webhookId: string): string =>
    `circuit:${webhookId}`,
} as const

// ═════════════════════════════════════════════════════════════
// 4. Environment schemas (Zod)
//    One schema per service. Validated at startup via loadEnv().
//    Add new vars here; the service fails fast if they're missing.
// ═════════════════════════════════════════════════════════════

const baseEnvSchema = z.object({
  NODE_ENV:     z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL:    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL:    z.string().url('REDIS_URL must be a valid URL'),
})

export const wsGatewayEnvSchema = baseEnvSchema.extend({
  PORT:                    z.coerce.number().int().positive().default(3002),
  WS_TOKEN_SECRET:         z.string().min(32, 'WS_TOKEN_SECRET must be at least 32 characters'),
  WS_NODE_ID:              z.string().default(() => `node-${process.pid}`),
  WS_HEARTBEAT_MS:         z.coerce.number().int().positive().default(30_000),
  WS_RATE_LIMIT_MAX:       z.coerce.number().int().positive().default(20),
  WS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  WS_WORKER_CONCURRENCY:   z.coerce.number().int().positive().default(50),
})

export const ingestionApiEnvSchema = baseEnvSchema.extend({
  PORT:              z.coerce.number().int().positive().default(3000),
  INGESTION_API_KEY: z.string().min(32, 'INGESTION_API_KEY must be at least 32 characters'),
})

export const fanOutEnvSchema = baseEnvSchema.extend({
  FAN_OUT_CONCURRENCY: z.coerce.number().int().positive().default(20),
})

export const webhookServiceEnvSchema = baseEnvSchema.extend({
  WEBHOOK_CONCURRENCY:          z.coerce.number().int().positive().default(10),
  WEBHOOK_TIMEOUT_MS:           z.coerce.number().int().positive().default(30_000),
  WEBHOOK_CIRCUIT_BREAK_THRESHOLD: z.coerce.number().int().positive().default(5),
  WEBHOOK_CIRCUIT_BREAK_RESET_MS:  z.coerce.number().int().positive().default(60_000),
})

export type WsGatewayEnv      = z.infer<typeof wsGatewayEnvSchema>
export type IngestionApiEnv   = z.infer<typeof ingestionApiEnvSchema>
export type FanOutEnv         = z.infer<typeof fanOutEnvSchema>
export type WebhookServiceEnv = z.infer<typeof webhookServiceEnvSchema>

// ═════════════════════════════════════════════════════════════
// 5. Environment loader
//    Loads .env (if present), validates against the schema, and
//    returns the typed config object. Exits with a readable error
//    message if any required variables are missing or invalid.
// ═════════════════════════════════════════════════════════════

export function loadEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  // Load .env file if present (no-op if not found)
  dotenv.config()

  const result = schema.safeParse(process.env)

  if (!result.success) {
    console.error('\n[shared] ✗ Invalid environment variables:\n')
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`)
    }
    console.error('\nFix the above variables and restart.\n')
    process.exit(1)
  }

  return result.data
}

// ═════════════════════════════════════════════════════════════
// 6. Redis singleton
//    Shared ioredis instance. Call initRedis() once at startup;
//    use getRedis() everywhere else.
//
//    Two separate connections are kept:
//      _appRedis     — general SET/GET/DEL from application code
//      _bullRedis    — dedicated to BullMQ (blocking commands;
//                      maxRetriesPerRequest: null required by BullMQ)
//
//    Note: BullMQ requires its own connection because it issues
//    blocking commands (BLPOP / BRPOPLPUSH). Mixing blocking
//    commands with regular commands on the same connection causes
//    queue delays — the regular commands wait behind the block.
// ═════════════════════════════════════════════════════════════

let _appRedis: Redis | null = null

export function initRedis(url: string): Redis {
  if (_appRedis) return _appRedis

  const opts: RedisOptions = {
    // Reconnect indefinitely — app code does not implement manual
    // retry; losing Redis would cause job processing to stall.
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
    lazyConnect:          true,
  }

  _appRedis = new IORedis(url, opts)

  _appRedis.on('connect',     () => console.log('[shared] Redis connected'))
  _appRedis.on('ready',       () => console.log('[shared] Redis ready'))
  _appRedis.on('error',    (err) => console.error('[shared] Redis error', err))
  _appRedis.on('reconnecting', () => console.warn('[shared] Redis reconnecting…'))

  return _appRedis
}

export function getRedis(): Redis {
  if (!_appRedis) {
    throw new Error('Redis not initialised — call initRedis(url) before getRedis()')
  }
  return _appRedis
}

export async function closeRedis(): Promise<void> {
  if (_appRedis) {
    await _appRedis.quit()
    _appRedis = null
  }
}

/**
 * Create a dedicated ioredis connection for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` and recommends
 * `enableReadyCheck: false`. Do NOT reuse getRedis() here —
 * blocking commands from BullMQ will starve regular commands.
 */
export function createBullMQConnection(url: string): Redis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
    lazyConnect:          true,
  })
}

// ═════════════════════════════════════════════════════════════
// 7. Database disconnect
//    Each service manages its own DB pool. disconnectDb() is a
//    no-op hook that services override in their own shutdown path
//    (or call their own pool.end() directly).
//
//    The reason it lives here: index.ts calls it in the shared
//    shutdown sequence, keeping the service's main file clean of
//    direct Prisma/pg imports for the shutdown path only.
// ═════════════════════════════════════════════════════════════

// Registry: service registers its own disconnect function here
let _dbDisconnect: (() => Promise<void>) | null = null

export function registerDbDisconnect(fn: () => Promise<void>): void {
  _dbDisconnect = fn
}

export async function disconnectDb(): Promise<void> {
  if (_dbDisconnect) {
    await _dbDisconnect()
    _dbDisconnect = null
  }
}
