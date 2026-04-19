import { createHmac, timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { GatewayError } from '../lib/errors'

// ─────────────────────────────────────────────────────────────
// WebSocket authentication strategy
//
// HTTP auth middleware can't be applied to WebSocket upgrades
// in the same way as HTTP routes — the upgrade handshake is a
// single HTTP GET and the socket is then taken over by the ws
// protocol. Cookies and Authorization headers still work, but
// JWT Bearer tokens in query strings are common for WS clients
// (especially browser-based) because headers are harder to set.
//
// We support both:
//   ?token=<signed-token>   (query param — browser clients)
//   Authorization: Bearer <token>  (header — server-side clients)
//
// Token format: base64url( JSON payload ) . HMAC-SHA256 signature
// Payload: { userId, tenantId, exp }
//
// Why not JWT?
// Full JWT adds a dependency (jsonwebtoken, jose) for what is
// a simple HMAC check. Our token format is equivalent in security
// and readable without a library. In production you'd likely
// validate against a shared secret or public key issued by your
// auth service — the interface here is the same either way.
// ─────────────────────────────────────────────────────────────

// TOKEN_SECRET is intentionally NOT read at module load time.
//
// Module-level code executes when the module is first imported,
// which happens before main() calls loadEnv(). Reading the secret
// here would see the env var as undefined if it comes from a .env
// file, silently falling back to the insecure default.
//
// Instead, the secret is read lazily inside sign() on every call.
// The overhead is negligible (a single process.env lookup) and
// correctness is guaranteed regardless of env load ordering.

const tokenPayloadSchema = z.object({
  userId:   z.string().uuid(),
  tenantId: z.string().uuid(),
  exp:      z.number().int(), // Unix timestamp seconds
})

export type TokenPayload = z.infer<typeof tokenPayloadSchema>

export class TokenAuthService {

  // Issued by your auth service when the client requests a
  // WS connection token. Not called by the gateway itself —
  // included here so the format is documented alongside verification.
  issueToken(payload: Omit<TokenPayload, 'exp'>, ttlSeconds = 300): string {
    const exp     = Math.floor(Date.now() / 1000) + ttlSeconds
    const body    = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url')
    const sig     = this.sign(body)
    return `${body}.${sig}`
  }

  // Called on every WebSocket upgrade request.
  // Throws GatewayError on any auth failure — the WS handler
  // catches and closes the socket with the appropriate code.
  verify(rawToken: string): TokenPayload {
    const parts = rawToken.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw GatewayError.authFailed('Malformed token')
    }

    const [body, receivedSig] = parts as [string, string]

    // ── Signature check ──────────────────────────────────────
    const expectedSig = this.sign(body)

    // timingSafeEqual — prevents timing oracle on signature bytes
    const receivedBuf = Buffer.from(receivedSig)
    const expectedBuf = Buffer.from(expectedSig)

    if (
      receivedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(receivedBuf, expectedBuf)
    ) {
      throw GatewayError.authFailed('Invalid token signature')
    }

    // ── Payload parse ────────────────────────────────────────
    let raw: unknown
    try {
      raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'))
    } catch {
      throw GatewayError.authFailed('Token payload is not valid JSON')
    }

    const result = tokenPayloadSchema.safeParse(raw)
    if (!result.success) {
      throw GatewayError.authFailed('Token payload schema invalid')
    }

    // ── Expiry check ─────────────────────────────────────────
    const now = Math.floor(Date.now() / 1000)
    if (result.data.exp < now) {
      throw GatewayError.authExpired()
    }

    return result.data
  }

  // Extracts the raw token from either query param or header
  extractToken(
    query:   Record<string, string | string[] | undefined>,
    headers: Record<string, string | string[] | undefined>
  ): string {
    // Query param takes precedence — standard for browser WebSocket clients
    const fromQuery = query['token']
    if (fromQuery && typeof fromQuery === 'string') return fromQuery

    // Header — server-to-server clients
    const authHeader = headers['authorization']
    if (authHeader && typeof authHeader === 'string') {
      const bearer = authHeader.replace(/^Bearer\s+/i, '')
      if (bearer) return bearer
    }

    throw GatewayError.authFailed('No token provided')
  }

  private sign(body: string): string {
    // Read lazily so loadEnv() in main() has already populated process.env
    // by the time the first token is signed or verified.
    const secret = process.env['WS_TOKEN_SECRET'] ?? 'dev-secret-change-in-production'
    return createHmac('sha256', secret).update(body).digest('base64url')
  }
}
