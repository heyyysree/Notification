import type { WebSocket, WebSocketServer } from 'ws'
import { logger } from '../lib/logger'

// ─────────────────────────────────────────────────────────────
// Why a heartbeat?
// TCP connections can become "half-open" — the server thinks
// the connection is alive but the client is gone (mobile app
// killed, network change, laptop sleep). The TCP stack may
// not detect this for minutes or hours depending on keep-alive
// settings. Half-open connections:
//   - Consume memory in the connection store
//   - Block new connections if you enforce one-per-user
//   - Skew your "connected users" metrics upward
//
// The WebSocket ping/pong mechanism lets us detect this:
//   1. Server sends a ping frame every N seconds
//   2. Client responds with a pong frame (browser does this
//      automatically; custom clients must handle it)
//   3. If no pong arrives before the next ping cycle,
//      the connection is terminated and cleaned up
//
// Why track per-socket isAlive rather than globally?
// Under concurrent connections, a global flag would create
// a race condition — a pong from socket A could reset the
// flag that was just set by a ping to socket B.
// ─────────────────────────────────────────────────────────────

// Augment WebSocket with our heartbeat flag
export interface HeartbeatSocket extends WebSocket {
  isAlive: boolean
}

export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly intervalMs: number = 30_000
  ) {}

  start(
    wss:         WebSocketServer,
    onTerminate: (socket: HeartbeatSocket) => void
  ): void {
    if (this.timer) return // already running

    this.timer = setInterval(() => {
      wss.clients.forEach(rawSocket => {
        const socket = rawSocket as HeartbeatSocket

        if (!socket.isAlive) {
          // Did not respond to last ping — connection is dead
          logger.debug('Terminating zombie socket (no pong received)')
          onTerminate(socket)
          socket.terminate() // hard close, no close frame
          return
        }

        // Reset flag — will only be set back to true when pong arrives
        socket.isAlive = false
        socket.ping()
      })
    }, this.intervalMs)

    // Don't prevent process exit if this is the only thing running
    this.timer.unref()

    logger.info({ intervalMs: this.intervalMs }, 'Heartbeat service started')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      logger.info('Heartbeat service stopped')
    }
  }

  // Call this on socket creation to initialise the flag and
  // set up the pong handler
  register(socket: HeartbeatSocket): void {
    socket.isAlive = true
    socket.on('pong', () => {
      socket.isAlive = true
    })
  }
}
