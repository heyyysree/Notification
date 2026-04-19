import http, { type IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer } from 'ws'
import {
  loadEnv,
  wsGatewayEnvSchema,
  initRedis,
  closeRedis,
  disconnectDb,
} from '@notification-engine/shared'
import { InMemoryConnectionStore } from './connection/connection-store'
import { WsConnectionHandler }    from './connection/ws-connection-handler'
import { createWsDeliveryWorker } from './workers/ws-delivery.worker'
import { createHttpApp }          from './routes/health.route'
import { ConnectionRateLimiter }  from './lib/rate-limiter'
import { logger }                 from './lib/logger'

async function main() {
  // ── 1. Validate environment ──────────────────────────────────
  const env = loadEnv(wsGatewayEnvSchema)

  logger.info(
    { nodeEnv: env.NODE_ENV, nodeId: env.WS_NODE_ID },
    'WS gateway starting'
  )

  // ── 2. Initialise shared dependencies ────────────────────────
  initRedis(env.REDIS_URL)

  // ── 3. Build services ─────────────────────────────────────────
  const connectionStore   = new InMemoryConnectionStore()
  const connectionHandler = new WsConnectionHandler(
    connectionStore,
    env.WS_HEARTBEAT_MS,
  )

  // Sliding-window rate limiter — rejects upgrade attempts from
  // IPs that exceed WS_RATE_LIMIT_MAX connections per
  // WS_RATE_LIMIT_WINDOW_MS. Checked before the WS handshake so
  // bad actors are rejected at the HTTP/TCP layer, not after a
  // full auth round-trip.
  const rateLimiter = new ConnectionRateLimiter(
    env.WS_RATE_LIMIT_MAX,
    env.WS_RATE_LIMIT_WINDOW_MS,
  )

  // ── 4. Create servers ─────────────────────────────────────────
  // Both HTTP and WebSocket share a single Node.js HTTP server.
  // We use noServer: true + a manual 'upgrade' handler so that
  // rate limiting (and path filtering) can happen before the
  // WebSocket handshake completes. If we passed `server:` directly
  // to WebSocketServer, upgrades would already be accepted before
  // we could reject them with a proper HTTP 429.
  const httpApp    = createHttpApp(connectionStore)
  const httpServer = http.createServer(httpApp)

  const wss = new WebSocketServer({
    noServer:       true,
    // clientTracking = true (default) — wss.clients is the Set
    // the heartbeat service iterates over.
    clientTracking: true,
  })

  connectionHandler.attach(wss)

  // ── WebSocket upgrade handler ─────────────────────────────────
  // Intercept every HTTP upgrade request so we can:
  //   1. Filter to /ws path only (reject others with 404)
  //   2. Apply per-IP rate limiting (reject with 429)
  //   3. Let the ws library complete the handshake
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    )

    // Only accept upgrades to /ws
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    // Per-IP rate limiting — before the WS handshake
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (!rateLimiter.isAllowed(ip)) {
      logger.warn({ ip }, 'WS upgrade rejected — rate limit exceeded')
      socket.write(
        'HTTP/1.1 429 Too Many Requests\r\n' +
        'Retry-After: 60\r\n' +
        'Connection: close\r\n\r\n',
      )
      socket.destroy()
      return
    }

    // Hand off to the ws library to complete the handshake
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  // ── 5. Start BullMQ delivery worker ───────────────────────────
  // Co-located with the WS server so it has direct access to the
  // in-memory connection store. See ws-delivery.worker.ts for
  // the full explanation of why this is correct for Phase 1.
  const { worker } = createWsDeliveryWorker(env, connectionStore)

  // ── 6. Start listening ────────────────────────────────────────
  httpServer.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, wsPath: '/ws' },
      'WS gateway listening',
    )
  })

  // ── 7. Graceful shutdown ──────────────────────────────────────
  // WS gateway shutdown is more complex than other services
  // because it has three things to drain:
  //
  //   1. BullMQ worker — finish active delivery jobs first so we
  //      don't attempt to deliver to sockets we're about to close
  //   2. WebSocket connections — send 1001 Going Away so clients
  //      know to reconnect immediately to another instance
  //   3. HTTP server — stop accepting new connections
  //   4. Redis + DB — clean resource release
  //
  // Without sending Going Away frames, clients sit in a broken
  // state until their own timeout fires (up to 60 s of missed
  // notifications).

  let isShuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info({ signal, connections: connectionStore.size() }, 'Shutdown initiated')

    // ── Forced-exit watchdog ────────────────────────────────────
    // Placed here — inside shutdown() — so it counts 30 s from
    // when shutdown *begins*, not from process start. A watchdog
    // set at startup with .unref() would expire ~30 s post-launch
    // rather than 30 s after shutdown was triggered.
    const watchdog = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 30 s — forcing exit')
      process.exit(1)
    }, 30_000)
    watchdog.unref()

    // Stop heartbeat — don't kill sockets we're about to close gracefully
    connectionHandler.stop()

    // Stop rate limiter cleanup timer
    rateLimiter.stop()

    // Stop accepting new delivery jobs before closing sockets
    await worker.close()
    logger.info('Delivery worker drained')

    // Send Going Away to all connected clients
    const closePromises: Promise<void>[] = []
    wss.clients.forEach(socket => {
      closePromises.push(
        new Promise<void>(resolve => {
          socket.close(1001, 'Server restarting — please reconnect')
          socket.once('close', resolve)
          // Force-terminate after 5 s if close handshake stalls
          setTimeout(() => { socket.terminate(); resolve() }, 5_000).unref()
        }),
      )
    })

    await Promise.all(closePromises)
    logger.info('All WS clients closed')

    // Stop HTTP server
    await new Promise<void>((resolve, reject) => {
      httpServer.close(err => (err ? reject(err) : resolve()))
    })

    await closeRedis()
    await disconnectDb()

    clearTimeout(watchdog)
    logger.info('WS gateway shut down cleanly')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))

  // Attempt graceful shutdown on unhandled errors before exiting.
  // The isShuttingDown guard prevents re-entry if shutdown itself throws.
  process.on('unhandledRejection', reason => {
    logger.error({ reason }, 'Unhandled rejection — shutting down')
    shutdown('unhandledRejection').finally(() => process.exit(1))
  })

  process.on('uncaughtException', err => {
    logger.error({ err }, 'Uncaught exception — shutting down')
    shutdown('uncaughtException').finally(() => process.exit(1))
  })
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
