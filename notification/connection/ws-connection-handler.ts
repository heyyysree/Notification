import type { IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { IConnectionStore } from '../connection/connection-store'
import type { HeartbeatSocket } from '../services/heartbeat.service'
import { HeartbeatService } from '../services/heartbeat.service'
import { TokenAuthService } from '../services/token-auth.service'
import { WS_CLOSE_CODES, isGatewayError } from '../lib/errors'
import { logger } from '../lib/logger'

// ─────────────────────────────────────────────────────────────
// Client → Server message types
// Clients can send messages too — not just receive.
// Keeping this schema explicit prevents the gateway from
// acting on unrecognised payloads.
// ─────────────────────────────────────────────────────────────

interface AckMessage {
  type:       'ack'
  deliveryId: string
}

type ClientMessage = AckMessage

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' && parsed !== null &&
      'type' in parsed && typeof (parsed as Record<string, unknown>)['type'] === 'string'
    ) {
      return parsed as ClientMessage
    }
    return null
  } catch {
    return null
  }
}

export class WsConnectionHandler {
  private readonly authService:      TokenAuthService
  private readonly heartbeatService: HeartbeatService

  constructor(
    private readonly connectionStore: IConnectionStore,
    heartbeatIntervalMs = 30_000
  ) {
    this.authService      = new TokenAuthService()
    this.heartbeatService = new HeartbeatService(heartbeatIntervalMs)
  }

  // Attaches the upgrade handler and heartbeat to a WebSocketServer.
  // Called once at startup.
  attach(wss: WebSocketServer): void {
    this.heartbeatService.start(wss, socket => {
      const s = socket as HeartbeatSocket & { _userId?: string }
      if (s._userId) this.connectionStore.remove(s._userId)
    })

    wss.on('connection', (socket: WebSocket, req: IncomingMessage) =>
      this.handleConnection(socket, req)
    )

    logger.info('WS connection handler attached')
  }

  stop(): void {
    this.heartbeatService.stop()
  }

  // ─────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────

  private handleConnection(rawSocket: WebSocket, req: IncomingMessage): void {
    const socket   = rawSocket as HeartbeatSocket & { _userId?: string; _tenantId?: string }
    const socketIp = req.socket.remoteAddress ?? 'unknown'

    // Register for heartbeat immediately — before auth — so we
    // can detect dead connections even during the auth phase.
    this.heartbeatService.register(socket)

    // ── Auth ──────────────────────────────────────────────────
    let userId:   string
    let tenantId: string

    try {
      const query   = Object.fromEntries(
        new URL(req.url ?? '/', 'http://localhost').searchParams
      ) as Record<string, string>
      const headers = req.headers as Record<string, string | string[] | undefined>

      const rawToken = this.authService.extractToken(query, headers)
      const payload  = this.authService.verify(rawToken)

      userId   = payload.userId
      tenantId = payload.tenantId

    } catch (err) {
      if (isGatewayError(err)) {
        logger.warn({ ip: socketIp, code: err.closeCode }, `WS auth failed: ${err.message}`)
        socket.close(err.closeCode, err.message)
      } else {
        logger.error({ err }, 'Unexpected error during WS auth')
        socket.close(WS_CLOSE_CODES.INTERNAL_ERROR, 'Authentication error')
      }
      return
    }

    // ── Register connection ───────────────────────────────────
    socket._userId   = userId
    socket._tenantId = tenantId

    this.connectionStore.add(userId, tenantId, socket)

    const socketLog = logger.child({ userId, tenantId, ip: socketIp })
    socketLog.info({
      totalConnections: this.connectionStore.size(),
    }, 'WS client connected')

    // ── Send connected confirmation ───────────────────────────
    // Lets the client know auth succeeded and the socket is live.
    // Without this, clients have no signal that the handshake
    // completed successfully — they'd have to infer it from the
    // absence of a close frame.
    this.sendToSocket(socket, { type: 'connected', userId, timestamp: new Date().toISOString() })

    // ── Message handler ───────────────────────────────────────
    socket.on('message', (data) => {
      const raw = data.toString()
      const message = parseClientMessage(raw)

      if (!message) {
        socketLog.debug({ raw: raw.slice(0, 100) }, 'Unrecognised client message — ignoring')
        return
      }

      switch (message.type) {
        case 'ack':
          // Client acknowledged receipt of a delivery.
          // In Phase 1 we log it — in a future phase this
          // could trigger a DB update for confirmed delivery.
          socketLog.debug({ deliveryId: message.deliveryId }, 'Delivery ack received')
          break

        default:
          socketLog.debug({ type: (message as ClientMessage).type }, 'Unknown message type')
      }
    })

    // ── Disconnect handler ────────────────────────────────────
    socket.on('close', (code, reason) => {
      // Guard: only remove this userId if the store still maps it to
      // THIS socket. On a rapid reconnect, connectionStore.add() in the
      // new handler call replaces the old entry before the old socket's
      // 'close' event fires. Without this check, the close event for
      // the old socket would remove the new user's connection.
      const current = this.connectionStore.get(userId)
      if (current?.socket === socket) {
        this.connectionStore.remove(userId)
      }
      socketLog.info({
        code,
        reason:           reason.toString(),
        totalConnections: this.connectionStore.size(),
      }, 'WS client disconnected')
    })

    socket.on('error', (err) => {
      // Socket errors don't automatically close the socket — we must
      // terminate explicitly so the 'close' event fires and the store
      // entry is cleaned up. Without this, an errored socket stays in
      // the store as a zombie until the heartbeat kills it.
      socketLog.warn({ err }, 'WS socket error')
      // Same guard as the 'close' handler — avoid clobbering a new
      // connection that replaced this one between the error and now.
      const current = this.connectionStore.get(userId)
      if (current?.socket === socket) {
        this.connectionStore.remove(userId)
      }
      socket.terminate()
    })
  }

  private sendToSocket(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(payload), err => {
      if (err) logger.debug({ err }, 'Failed to send socket message')
    })
  }
}
