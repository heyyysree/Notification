import {
  loadEnv,
  ingestionApiEnvSchema,
  initRedis,
  closeRedis,
  disconnectDb,
} from '@notification-engine/shared'
import { buildApp } from './app.js'

async function main(): Promise<void> {
  // ── 1. Validate environment ──────────────────────────────────
  const env = loadEnv(ingestionApiEnvSchema)

  // ── 2. Init Redis (dedup keys + BullMQ queue connection) ─────
  initRedis(env.REDIS_URL)

  // ── 3. Build and start Fastify ───────────────────────────────
  const app = await buildApp()

  await app.listen({ port: env.PORT, host: '0.0.0.0' })

  // ── 4. Graceful shutdown ──────────────────────────────────────
  let isShuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true

    app.log.info({ signal }, 'Ingestion API shutting down')

    const watchdog = setTimeout(() => {
      app.log.error('Graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, 15_000)
    watchdog.unref()

    await app.close()
    await closeRedis()
    await disconnectDb()

    clearTimeout(watchdog)
    app.log.info('Ingestion API shut down cleanly')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))

  process.on('unhandledRejection', reason => {
    app.log.error({ reason }, 'Unhandled rejection')
    shutdown('unhandledRejection').finally(() => process.exit(1))
  })

  process.on('uncaughtException', err => {
    app.log.error({ err }, 'Uncaught exception')
    shutdown('uncaughtException').finally(() => process.exit(1))
  })
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
