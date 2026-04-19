import type { WsDeliveryJobPayload } from '@notification-engine/shared'
import { RedisKeys } from '@notification-engine/shared'
import type { Redis } from 'ioredis'
import { WebSocket } from 'ws'
import type { IConnectionStore } from '../connection/connection-store'
import { deliveryRepository } from '../repositories/delivery.repository'
import { logger } from '../lib/logger'

// ─────────────────────────────────────────────────────────────
// WS message envelope
// All messages sent down the socket follow this shape.
// The `type` field lets clients build a switch-based dispatcher
// without parsing `data` to determine what arrived.
// ─────────────────────────────────────────────────────────────

interface WsMessage {
  type:       'notification'
  deliveryId: string
  eventId:    string
  eventType:  string
  payload:    Record<string, unknown>
  timestamp:  string
}

// ─────────────────────────────────────────────────────────────
// Why a Redis deduplication check inside the WS processor?
// The DB has a unique constraint on (eventId, userId, channel)
// that prevents duplicate delivery records. But the constraint
// is at the record level — it doesn't prevent us from attempting
// to send the same notification twice if the job is re-delivered.
//
// Redis dedup is a fast pre-check: if the key exists, we know
// the notification was already sent in the last 24h and we skip
// the socket write entirely. This is the correct order:
//   1. Redis dedup check (fast, in-memory)
//   2. Socket write
//   3. Redis dedup key set  ← BEFORE DB update (see step 5 comment)
//   4. DB status update
//
// Without the Redis check, a BullMQ job re-delivery after a
// crash would send the same notification twice to the client.
// ─────────────────────────────────────────────────────────────

export class WsDeliveryProcessor {
  constructor(
    private readonly connectionStore: IConnectionStore,
    private readonly redis:           Redis
  ) {}

  async process(job: WsDeliveryJobPayload): Promise<void> {
    const { deliveryId, eventId, userId, tenantId, payload } = job

    const jobLog = logger.child({ deliveryId, eventId, userId })

    // ── Step 1: Dedup check ────────────────────────────────────
    const dedupKey = RedisKeys.dedup(eventId, userId, 'websocket')
    const alreadySent = await this.redis.get(dedupKey)

    if (alreadySent) {
      jobLog.debug('Delivery deduped via Redis — already sent')
      await deliveryRepository.markDeduped(deliveryId).catch(err =>
        jobLog.error({ err }, 'Failed to mark delivery as deduped')
      )
      return
    }

    // ── Step 2: Look up the socket ─────────────────────────────
    const connection = this.connectionStore.get(userId)

    if (!connection) {
      // ─────────────────────────────────────────────────────
      // User is not connected — this is the normal case, not an
      // error. Most notification systems see <10% of users
      // connected at any time. Phase 3 handles this by falling
      // back to push notifications. For now, we mark failed
      // so the delivery record reflects the outcome truthfully.
      //
      // An alternative would be to hold the job in a per-user
      // "pending delivery" queue and flush it when the user
      // connects. That's the "message inbox" pattern — a valid
      // Phase 2 addition, but out of scope here.
      // ─────────────────────────────────────────────────────
      jobLog.debug('User not connected — marking delivery failed')
      await deliveryRepository.markFailed(
        deliveryId,
        'user not connected at delivery time'
      ).catch(err => jobLog.error({ err }, 'Failed to mark delivery'))
      return
    }

    // ── Step 3: Build message ──────────────────────────────────
    const message: WsMessage = {
      type:       'notification',
      deliveryId,
      eventId,
      // `as string` is a TypeScript type assertion, not a runtime coercion.
      // A non-string value (number, object, undefined) would pass through
      // undetected. Use a typeof guard so the fallback actually fires.
      eventType:  typeof payload['eventType'] === 'string' ? payload['eventType'] : 'unknown',
      payload,
      timestamp:  new Date().toISOString(),
    }

    // ── Step 4: Send to socket ─────────────────────────────────
    // ws.send() is async — it buffers and sends when the socket
    // is writable. The callback fires when the bytes are written
    // to the OS network buffer, not when the client receives them.
    // That's the best guarantee we can get at the transport layer.
    const sent = await this.sendToSocket(connection.socket, message, jobLog)

    // ── Step 5: Update delivery record and set dedup key ──────
    if (sent) {
      // Set dedup key BEFORE marking sent in DB.
      // If we crash after setting the dedup key but before the DB
      // update, a BullMQ retry is caught at step 1 — no duplicate.
      // If we crash before setting the key, the retry will attempt
      // to resend, which is the correct fallback.
      //
      // We deliberately swallow redis.set errors here. If Redis is
      // temporarily unavailable, failing the job and retrying via
      // BullMQ would re-send the notification without the dedup
      // key ever being set — a worse outcome than a stale DB record.
      // The DB unique constraint on (eventId, userId, channel) is
      // the last line of defence against truly duplicate records.
      await this.redis.set(dedupKey, '1', 'EX', 86_400).catch(err =>
        jobLog.warn({ err }, 'Failed to set dedup key — retry may re-deliver')
      )
      await deliveryRepository.markSent(deliveryId).catch(err =>
        jobLog.error({ err }, 'Failed to mark delivery as sent')
      )
      jobLog.info('WS delivery sent')
    } else {
      await deliveryRepository.markFailed(deliveryId, 'socket write failed').catch(err =>
        jobLog.error({ err }, 'Failed to mark delivery as failed')
      )
      jobLog.warn('WS delivery failed — socket write returned error')
    }
  }

  private sendToSocket(
    socket:  WebSocket,
    message: WsMessage,
    log:     ReturnType<typeof logger.child>
  ): Promise<boolean> {
    return new Promise(resolve => {
      // Check socket state before attempting to send.
      // WebSocket.OPEN = 1. Sending to a closing or closed socket throws.
      if (socket.readyState !== WebSocket.OPEN) {
        log.debug({ readyState: socket.readyState }, 'Socket not open — skipping send')
        resolve(false)
        return
      }

      socket.send(JSON.stringify(message), err => {
        if (err) {
          log.warn({ err }, 'Socket send error')
          resolve(false)
        } else {
          resolve(true)
        }
      })
    })
  }
}
