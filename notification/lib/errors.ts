// ─────────────────────────────────────────────────────────────
// WebSocket close codes used by the gateway.
//
// The WebSocket spec reserves codes 4000–4999 for private use.
// We use a 4xxx scheme that mirrors HTTP status codes so the
// meaning is immediately recognisable to client engineers:
//   4001 — auth failed  (like HTTP 401)
//   4002 — token expired
//   4029 — rate limited (like HTTP 429)
//   4500 — internal server error (like HTTP 500)
// ─────────────────────────────────────────────────────────────

export const WS_CLOSE_CODES = {
  AUTH_FAILED:    4001,
  AUTH_EXPIRED:   4002,
  RATE_LIMITED:   4029,
  INTERNAL_ERROR: 4500,
} as const

export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES]

// ─────────────────────────────────────────────────────────────
// GatewayError carries a WebSocket close code so the connection
// handler can close the socket with the right code without
// needing a switch statement on every error type.
//
// Usage:
//   throw GatewayError.authFailed('Token signature mismatch')
//   // → socket.close(4001, 'Token signature mismatch')
// ─────────────────────────────────────────────────────────────

export class GatewayError extends Error {
  readonly name = 'GatewayError'

  constructor(
    message:               string,
    readonly closeCode:    WsCloseCode,
  ) {
    super(message)
    // Restore prototype chain broken by extending Error in TS/ES5 targets
    Object.setPrototypeOf(this, new.target.prototype)
  }

  static authFailed(message: string): GatewayError {
    return new GatewayError(message, WS_CLOSE_CODES.AUTH_FAILED)
  }

  static authExpired(): GatewayError {
    return new GatewayError('Token has expired', WS_CLOSE_CODES.AUTH_EXPIRED)
  }

  static rateLimited(): GatewayError {
    return new GatewayError('Too many connections', WS_CLOSE_CODES.RATE_LIMITED)
  }

  static internal(message = 'Internal server error'): GatewayError {
    return new GatewayError(message, WS_CLOSE_CODES.INTERNAL_ERROR)
  }
}

/** Type guard — narrow unknown catch values to GatewayError */
export function isGatewayError(err: unknown): err is GatewayError {
  return err instanceof GatewayError
}
