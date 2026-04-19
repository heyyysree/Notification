import { Worker, Queue, type Job } from 'bullmq'
import pino from 'pino'
import {
  QUEUES,
  createBullMQConnection,
  type FanOutJobPayload,
  type WsDeliveryJobPayload,
  type WebhookDeliveryJobPayload,
} from '@notification-engine/shared'
import {
  getWsSubscribers,
  getWebhookSubscribers,
} from '../repositories/subscription.repository.js'
import {
  createDelivery,
  markEventProcessed,
  markEventFailed,
} from '../repositories/delivery.repository.js'

// ─────────────────────────────────────────────────────────────────
// Fan-out worker
//
// Consumes `notification:fan-out`. For each event:
//
//   1. Resolve WS subscribers  → (tenantId, eventType) + wildcards
//   2. Resolve webhook configs → (tenantId, eventType) + wildcards
//   3. For each subscriber:
//      a. INSERT delivery row  (status = 'pending')
//      b. Enqueue channel job  (ws-delivery or webhook-delivery)
//   4. Mark event 'processed'
//
// Store-before-enqueue ordering:
//   The delivery INSERT always happens before Queue.add(). If the
//   process crashes between INSERT and Queue.add, the delivery row
//   sits at 'pending' permanently — visible to operators, safe to
//   requeue. A crashed Queue.add cannot produce a job for a
//   delivery row that doesn't exist yet (no FK violations, no
//   silent drops).
//
// Fan-out idempotency:
//   createDelivery uses ON CONFLICT DO NOTHING — if the fan-out
//   job is retried, existing delivery rows are not overwritten.
//   The corresponding Queue.add uses the delivery ID as the BullMQ
//   job ID, so BullMQ also deduplicates at the queue level.
// ─────────────────────────────────────────────────────────────────

const logger = pino({
  level:      process.env['LOG_LEVEL'] ?? 'info',
  messageKey: 'message',
  base: { pid: process.pid, service: 'fan-out' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, messageKey: 'message' } }
    : undefined,
})

// Module-level queue singletons
let _wsQueue:      Queue<WsDeliveryJobPayload>      | null = null
let _webhookQueue: Queue<WebhookDeliveryJobPayload> | null = null

function getWsQueue(redisUrl: string): Queue<WsDeliveryJobPayload> {
  if (!_wsQueue) {
    _wsQueue = new Queue<WsDeliveryJobPayload>(
      QUEUES.WS_DELIVERY,
      { connection: createBullMQConnection(redisUrl) },
    )
  }
  return _wsQueue
}

function getWebhookQueue(redisUrl: string): Queue<WebhookDeliveryJobPayload> {
  if (!_webhookQueue) {
    _webhookQueue = new Queue<WebhookDeliveryJobPayload>(
      QUEUES.WEBHOOK_DELIVERY,
      { connection: createBullMQConnection(redisUrl) },
    )
  }
  return _webhookQueue
}

export function createFanOutWorker(redisUrl: string, concurrency = 20) {
  const workerConn = createBullMQConnection(redisUrl)

  const worker = new Worker<FanOutJobPayload>(
    QUEUES.FAN_OUT,

    async (job: Job<FanOutJobPayload>) => {
      const { eventId, tenantId, eventType, payload } = job.data

      const jobLog = logger.child({ eventId, tenantId, eventType, jobId: job.id })
      jobLog.info('Fan-out started')

      let wsCount      = 0
      let webhookCount = 0
      let errorCount   = 0

      try {
        // ── 1. Resolve subscribers ────────────────────────────────
        const [wsSubscribers, webhookConfigs] = await Promise.all([
          getWsSubscribers(tenantId, eventType),
          getWebhookSubscribers(tenantId, eventType),
        ])

        const wsQueue      = getWsQueue(redisUrl)
        const webhookQueue = getWebhookQueue(redisUrl)

        // ── 2. WebSocket deliveries ───────────────────────────────
        for (const sub of wsSubscribers) {
          try {
            // a. INSERT delivery row (pending)
            const deliveryId = await createDelivery({
              eventId,
              userId:   sub.userId,
              tenantId,
              channel:  'websocket',
            })

            if (!deliveryId) {
              // ON CONFLICT — delivery already exists (fan-out retry)
              jobLog.debug({ userId: sub.userId }, 'WS delivery row already exists — skipping')
              continue
            }

            // b. Enqueue WS delivery job
            //    Job ID = deliveryId for BullMQ-level deduplication
            const wsPayload: WsDeliveryJobPayload = {
              deliveryId,
              eventId,
              userId:   sub.userId,
              tenantId,
              payload,
            }

            await wsQueue.add('ws-delivery', wsPayload, {
              jobId:    deliveryId,
              attempts: 3,
              backoff:  { type: 'fixed', delay: 1_000 },
              removeOnComplete: { count: 5_000 },
              removeOnFail:     { count: 1_000 },
            })

            wsCount++

          } catch (err) {
            // Don't fail the entire fan-out job for one subscriber.
            // Log and continue — the delivery row stays 'pending' for
            // operator inspection if the INSERT succeeded but Queue.add
            // failed.
            jobLog.error({ err, userId: sub.userId }, 'Failed to fan-out WS delivery')
            errorCount++
          }
        }

        // ── 3. Webhook deliveries ─────────────────────────────────
        for (const config of webhookConfigs) {
          try {
            const deliveryId = await createDelivery({
              eventId,
              userId:   config.webhookId,   // webhook ID acts as the "user" identifier
              tenantId,
              channel:  'webhook',
            })

            if (!deliveryId) {
              jobLog.debug({ webhookId: config.webhookId }, 'Webhook delivery row already exists — skipping')
              continue
            }

            const webhookPayload: WebhookDeliveryJobPayload = {
              deliveryId,
              eventId,
              tenantId,
              webhookId:   config.webhookId,
              endpointUrl: config.endpointUrl,
              secretId:    config.secretId,
              payload,
            }

            await webhookQueue.add('webhook-delivery', webhookPayload, {
              jobId:    deliveryId,
              attempts: 5,
              backoff:  { type: 'exponential', delay: 2_000 },
              removeOnComplete: { count: 2_000 },
              removeOnFail:     { count: 500 },
            })

            webhookCount++

          } catch (err) {
            jobLog.error({ err, webhookId: config.webhookId }, 'Failed to fan-out webhook delivery')
            errorCount++
          }
        }

        // ── 4. Mark event processed ───────────────────────────────
        await markEventProcessed(tenantId, eventId)

        jobLog.info({ wsCount, webhookCount, errorCount }, 'Fan-out complete')

      } catch (err) {
        await markEventFailed(tenantId, eventId, String(err)).catch(() => { /* best effort */ })
        throw err  // Re-throw so BullMQ retries the job
      }
    },

    {
      connection: workerConn,
      concurrency,
      lockDuration: 30_000,
    },
  )

  worker.on('failed', (job, err) => {
    logger.error({
      jobId:    job?.id,
      eventId:  job?.data.eventId,
      tenantId: job?.data.tenantId,
      err,
    }, 'Fan-out job failed')
  })

  worker.on('error', err => {
    logger.error({ err }, 'Fan-out worker error')
  })

  logger.info({ concurrency, queue: QUEUES.FAN_OUT }, 'Fan-out worker started')

  return { worker }
}
