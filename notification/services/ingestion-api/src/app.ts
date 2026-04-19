import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import { eventsRoutes }   from './routes/events.js'
import { bearerAuthHook } from './middleware/auth.js'

// ─────────────────────────────────────────────────────────────────
// Fastify application factory
//
// Kept separate from index.ts so tests can build an app instance
// without starting a real HTTP server.
// ─────────────────────────────────────────────────────────────────

export async function buildApp(opts?: { logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts?.logger !== false
      ? {
          level:      process.env['LOG_LEVEL'] ?? 'info',
          messageKey: 'message',
          base: {
            pid:     process.pid,
            service: 'ingestion-api',
          },
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
        }
      : false,
  })

  // ── Security headers ─────────────────────────────────────────
  await app.register(helmet, { global: true })

  // ── Auth hook — applies to all routes except /health ─────────
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return
    await bearerAuthHook(req, reply)
  })

  // ── Routes ───────────────────────────────────────────────────
  await app.register(eventsRoutes)

  // ── Health ───────────────────────────────────────────────────
  app.get('/health', async () => ({
    status:    'ok',
    service:   'ingestion-api',
    uptime:    Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }))

  // ── Global error handler ──────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err, url: req.url }, 'Unhandled request error')

    // Validation errors from Fastify schema checks
    if (err.statusCode === 400) {
      return reply.code(400).send({
        error:   'Bad Request',
        message: err.message,
      })
    }

    return reply.code(500).send({
      error:   'Internal Server Error',
      message: process.env['NODE_ENV'] === 'production'
        ? 'An unexpected error occurred'
        : err.message,
    })
  })

  return app
}
