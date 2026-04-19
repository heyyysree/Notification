import type { FastifyInstance } from 'fastify'
import { Queue } from 'bullmq'
import { z } from 'zod'
import {
  QUEUES,
  RedisKeys,
  getRedis,
  createBullMQConnection,
  type FanOutJobPayload,
} from '@notification-engine/shared'
import { Pool } from 'pg'

// ─────────────────────────────────────────────────────────────────
// POST /v1/events — Ingestion route
//
// Accepts an event from a trusted producer, deduplicates it, writes
// it to the events table, and enqueues a fan-out job.
//
// Idempotency strategy (three-state Redis key):
//
//   Key absent  → first time seeing this eventId — proceed
//   Key = "1"   → another process is handling it right now — 409
//   Key = "ok"  → already processed — replay 202 immediately
//
// The key is set to "1" (processing) before the DB write and
// updated to "ok" after the fan-out job is enqueued. This means:
//
//   - Crash between "1" and "ok": the key expires after 24h and
//     the producer can retry. Exactly-once is NOT guaranteed across
//     crashes, but duplicate fan-out jobs are deduplicated by the
//     fan-out worker via events.status check.
//
//   - Double request before "1" is set: the UNIQUE (tenant_id,
//     event_id) constraint on the events table is the last-resort
//     guard — the second INSERT will throw a unique violation.
// ─────────────────────────────────────────────────────────────────

const eventBodySchema = z.object({
  eventId:   z.string().min(1).max(255),
  eventType: z.string().min(1).max(255),
  payload:   z.record(z.unknown()).default({}),
})

type EventBody = z.infer<typeof eventBodySchema>

// Module-level singletons — initialised once at app startup
let _fanOutQueue: Queue<FanOutJobPayload> | null = null
let _pool:        Pool | null                    = null

function getFanOutQueue(): Queue<FanOutJobPayload> {
  if (!_fanOutQueue) {
    const redisUrl = process.env['REDIS_URL']
    if (!redisUrl) throw new Error('REDIS_URL is not set')
    const conn = createBullMQConnection(redisUrl)
    _fanOutQueue = new Queue<FanOutJobPayload>(QUEUES.FAN_OUT, { connection: conn })
  }
  return _fanOutQueue
}

function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env['DATABASE_URL']
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    _pool = new Pool({ connectionString, max: 5 })
    _pool.on('error', err => console.error('[ingestion] Idle DB client error', err))
  }
  return _pool
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/events ──────────────────────────────────────────
  app.post<{ Body: EventBody }>(
    '/v1/events',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['x-tenant-id'],
          properties: {
            'x-tenant-id': { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      // ── Parse & validate body ──────────────────────────────────
      const parseResult = eventBodySchema.safeParse(req.body)
      if (!parseResult.success) {
        return reply.code(400).send({
          error:   'Bad Request',
          message: 'Invalid event body',
          issues:  parseResult.error.issues,
        })
      }

      const { eventId, eventType, payload } = parseResult.data
      const tenantId = (req.headers['x-tenant-id'] as string).toLowerCase()

      const redis = getRedis()
      const idempotencyKey = RedisKeys.ingestionIdempotency(eventId)

      // ── Step 1: Dedup check ────────────────────────────────────
      const existing = await redis.get(idempotencyKey)

      if (existing === 'ok') {
        // Already processed — replay 202 (idempotent success)
        req.log.debug({ eventId, tenantId }, 'Event already processed — replaying 202')
        return reply.code(202).send({ eventId, status: 'accepted' })
      }

      if (existing === '1') {
        // Another process is currently handling this event
        req.log.warn({ eventId, tenantId }, 'Event processing in progress — 409')
        return reply.code(409).send({
          error:   'Conflict',
          message: 'Event is currently being processed — retry in a moment',
        })
      }

      // ── Step 2: Mark as processing ─────────────────────────────
      // Set with EX so a crash during processing doesn't permanently
      // block the eventId. After 24h the producer can retry.
      await redis.set(idempotencyKey, '1', 'EX', 86_400)

      try {
        // ── Step 3: Persist event ──────────────────────────────────
        // INSERT ... ON CONFLICT DO NOTHING handles the rare race
        // where two identical requests arrive before either sets "1".
        await getPool().query(
          `INSERT INTO events (event_id, tenant_id, event_type, payload, status)
           VALUES ($1, $2, $3, $4, 'received')
           ON CONFLICT (tenant_id, event_id) DO NOTHING`,
          [eventId, tenantId, eventType, JSON.stringify(payload)],
        )

        // ── Step 4: Enqueue fan-out ────────────────────────────────
        // Job ID = eventId so BullMQ deduplicates at the queue level
        // if a retry arrives before the first job is processed.
        const fanOutPayload: FanOutJobPayload = {
          eventId,
          tenantId,
          eventType,
          payload,
        }

        await getFanOutQueue().add('fan-out', fanOutPayload, {
          jobId:    `${tenantId}:${eventId}`,
          attempts: 3,
          backoff:  { type: 'exponential', delay: 2_000 },
          removeOnComplete: { count: 1000 },
          removeOnFail:     { count: 500 },
        })

        // ── Step 5: Mark as done ───────────────────────────────────
        await redis.set(idempotencyKey, 'ok', 'EX', 86_400)

        req.log.info({ eventId, tenantId, eventType }, 'Event ingested')
        return reply.code(202).send({ eventId, status: 'accepted' })

      } catch (err) {
        // Reset idempotency key so the producer can retry
        await redis.del(idempotencyKey).catch(() => { /* best effort */ })
        req.log.error({ err, eventId, tenantId }, 'Failed to ingest event')
        throw err
      }
    },
  )

  // ── GET /v1/events/:eventId — status check ───────────────────
  app.get<{ Params: { eventId: string } }>(
    '/v1/events/:eventId',
    async (req, reply) => {
      const tenantId = (req.headers['x-tenant-id'] as string | undefined)?.toLowerCase()
      if (!tenantId) {
        return reply.code(400).send({ error: 'X-Tenant-ID header required' })
      }

      const { rows } = await getPool().query(
        `SELECT event_id, event_type, status, created_at
           FROM events
          WHERE tenant_id = $1 AND event_id = $2`,
        [tenantId, req.params.eventId],
      )

      if (!rows[0]) {
        return reply.code(404).send({ error: 'Event not found' })
      }

      return reply.send(rows[0])
    },
  )
}
