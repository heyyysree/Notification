import { Worker, type Job } from 'bullmq'
import type { WsDeliveryJobPayload } from '@notification-engine/shared'
import {
  QUEUES,
  createBullMQConnection,
  getRedis,
} from '@notification-engine/shared'
import type { IConnectionStore } from '../connection/connection-store'
import { WsDeliveryProcessor } from '../processors/ws-delivery.processor'
import { logger } from '../lib/logger'
import type { WsGatewayEnv } from '@notification-engine/shared'

// ─────────────────────────────────────────────────────────────
// Why does the WS gateway run a BullMQ worker alongside the
// WebSocket server in the same process?
//
// The connection store is in-memory. To deliver a job, the
// worker needs access to the socket object — which only exists
// in the process where the user connected.
//
// Phase 1: co-located worker + WS server. Simple. Works on
// a single node. The worker can call connectionStore.get()
// directly.
//
// Phase 2: the worker is replaced by a Redis pub/sub subscriber.
// The fan-out service publishes to ws:notify:{userId}. Every
// gateway node is subscribed to that channel. Only the node
// that holds the socket can deliver — other nodes ignore the
// message. The BullMQ WS queue is eliminated.
//
// This file and the worker below are Phase 1 only.
// Phase 2 replaces them with the pub/sub subscriber.
// ─────────────────────────────────────────────────────────────

export function createWsDeliveryWorker(
  env:             WsGatewayEnv,
  connectionStore: IConnectionStore
) {
  const workerConnection = createBullMQConnection(env.REDIS_URL)
  const redis            = getRedis()
  const processor        = new WsDeliveryProcessor(connectionStore, redis)

  const worker = new Worker<WsDeliveryJobPayload>(
    QUEUES.WS_DELIVERY,

    async (job: Job<WsDeliveryJobPayload>) => {
      await processor.process(job.data)
    },

    {
      connection: workerConnection,

      // ─────────────────────────────────────────────────────
      // Why high concurrency for WS delivery vs low for webhooks?
      // WS delivery is almost entirely I/O-free: a Map lookup,
      // a socket.send() (non-blocking, OS buffers it), and a
      // Redis SET. There's no outbound HTTP call with a 30s timeout.
      // Each job completes in microseconds. High concurrency
      // keeps the queue draining fast — CRITICAL priority events
      // should reach connected sockets in <100ms from enqueue.
      //
      // Read from env so this can be tuned without a code change
      // (e.g., lower it on memory-constrained nodes).
      // ─────────────────────────────────────────────────────
      concurrency: env.WS_WORKER_CONCURRENCY,

      // No limiter — WS delivery is local and fast.
      // The fan-out service's queue throughput is the upstream limit.

      lockDuration: 10_000,
    }
  )

  worker.on('failed', (job, err) => {
    logger.error({
      jobId:      job?.id,
      deliveryId: job?.data.deliveryId,
      userId:     job?.data.userId,
      err,
    }, 'WS delivery job failed')
  })

  worker.on('error', err => {
    logger.error({ err }, 'WS delivery worker error')
  })

  logger.info({ concurrency: env.WS_WORKER_CONCURRENCY, queue: QUEUES.WS_DELIVERY }, 'WS delivery worker started')

  return { worker }
}
