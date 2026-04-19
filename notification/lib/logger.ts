import pino from 'pino'

// ─────────────────────────────────────────────────────────────
// Structured JSON logger (Pino).
//
// In development, pino-pretty formats output for readability.
// In production, raw JSON is emitted for CloudWatch / Datadog.
//
// LOG_LEVEL defaults to 'info'. Set to 'debug' locally to see
// per-message and per-socket events.
//
// Usage:
//   logger.info({ userId, tenantId }, 'WS client connected')
//   logger.warn({ ip, code }, 'WS auth failed')
//
// Child loggers (bind context for the lifetime of a request):
//   const socketLog = logger.child({ userId, tenantId, ip })
// ─────────────────────────────────────────────────────────────

const isDev = process.env['NODE_ENV'] !== 'production'

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',

  // Use 'message' instead of pino's default 'msg' for log aggregator compatibility
  messageKey: 'message',

  base: {
    pid:     process.pid,
    service: 'ws-gateway',
    env:     process.env['NODE_ENV'] ?? 'development',
  },

  // ISO 8601 timestamps
  timestamp: pino.stdTimeFunctions.isoTime,

  transport: isDev
    ? {
        target:  'pino-pretty',
        options: {
          colorize:      true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore:        'pid,hostname,service,env',
          messageKey:    'message',
        },
      }
    : undefined,
})
