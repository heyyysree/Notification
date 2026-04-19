import type { RequestListener, IncomingMessage, ServerResponse } from 'http'
import type { IConnectionStore } from '../connection/connection-store'

// ─────────────────────────────────────────────────────────────
// Minimal HTTP application for the health check endpoint.
//
// Implemented as a raw Node.js RequestListener (no framework
// dependency) because this is the only HTTP route this service
// exposes. The WebSocket upgrade is handled separately on the
// 'upgrade' event of the same http.Server.
//
// Routes:
//   GET /health — liveness + connection count for dashboards
//   GET /ready  — readiness probe (returns 503 during shutdown)
//   *           — 404
// ─────────────────────────────────────────────────────────────

let isShuttingDown = false

/** Mark the gateway as shutting down — /ready will return 503 */
export function setShuttingDown(): void {
  isShuttingDown = true
}

export function createHttpApp(connectionStore: IConnectionStore): RequestListener {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const { method, url } = req

    // ── GET /health — liveness probe ──────────────────────────
    if (method === 'GET' && url === '/health') {
      const body = JSON.stringify({
        status:      'ok',
        service:     'ws-gateway',
        connections: connectionStore.size(),
        uptime:      Math.round(process.uptime()),
        timestamp:   new Date().toISOString(),
      })
      res.writeHead(200, {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    // ── GET /ready — readiness probe ───────────────────────────
    // Returns 503 during graceful shutdown so load balancers stop
    // routing new traffic here before the process exits.
    if (method === 'GET' && url === '/ready') {
      const status = isShuttingDown ? 503 : 200
      const body   = JSON.stringify({
        ready: !isShuttingDown,
        connections: connectionStore.size(),
      })
      res.writeHead(status, {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    // ── 404 fallthrough ────────────────────────────────────────
    const body = JSON.stringify({ error: 'Not found' })
    res.writeHead(404, {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }
}
