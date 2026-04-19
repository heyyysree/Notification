import http from 'http'
import { WebSocket } from 'ws'
import { TokenAuthService } from '../../services/token-auth.service'

// ─────────────────────────────────────────────────────────────────
// Test client helpers
//
// Provides typed wrappers around the raw WS and HTTP interfaces
// so test assertions stay readable and don't repeat boilerplate.
// ─────────────────────────────────────────────────────────────────

export interface ConnectOptions {
  userId?:   string
  tenantId?: string
  ttl?:      number
  token?:    string   // provide raw token to test auth failures
}

/**
 * Opens a WebSocket to the test server and waits for the 'connected'
 * confirmation message. Returns the socket and cleanup function.
 *
 * On auth failure the socket closes immediately; the promise rejects
 * with { code, reason } from the close event.
 */
export function connectWs(
  serverAddress: string,
  opts: ConnectOptions = {},
): Promise<{
  ws:         WebSocket
  messages:   unknown[]
  disconnect: () => void
}> {
  const authService = new TokenAuthService()

  const token = opts.token ?? authService.issueToken(
    {
      userId:   opts.userId   ?? '00000000-0000-0000-0000-000000000001',
      tenantId: opts.tenantId ?? '00000000-0000-0000-0000-000000000002',
    },
    opts.ttl ?? 300,
  )

  const wsUrl = `ws://${serverAddress}/ws?token=${token}`

  return new Promise((resolve, reject) => {
    const ws       = new WebSocket(wsUrl)
    const messages: unknown[] = []

    ws.on('message', data => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {
        messages.push(data.toString())
      }
    })

    ws.once('message', data => {
      const msg = JSON.parse(data.toString()) as { type: string }
      if (msg.type === 'connected') {
        resolve({
          ws,
          messages,
          disconnect: () => ws.close(),
        })
      } else {
        reject(new Error(`Expected 'connected' message, got: ${JSON.stringify(msg)}`))
      }
    })

    ws.on('close', (code, reason) => {
      reject(Object.assign(new Error(`WebSocket closed: ${reason}`), { code }))
    })

    ws.on('error', err => {
      reject(err)
    })
  })
}

/**
 * Makes a GET /health request to the test server.
 */
export function getHealth(address: string): Promise<{
  status:      number
  body:        Record<string, unknown>
}> {
  return new Promise((resolve, reject) => {
    http.get(`http://${address}/health`, res => {
      let raw = ''
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) })
        } catch {
          reject(new Error(`Failed to parse health response: ${raw}`))
        }
      })
    }).on('error', reject)
  })
}

/**
 * Waits until a predicate returns true, polling every `intervalMs`.
 * Rejects after `timeoutMs` if the predicate never returns true.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}
