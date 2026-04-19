import {
  loadEnv,
  fanOutEnvSchema,
  initRedis,
  closeRedis,
  disconnectDb,
  registerDbDisconnect,
} from '@notification-engine/shared'
import { createFanOutWorker } from './workers/fan-out.worker.js'
import { disconnectPool }    from './repositories/delivery.repository.js'

async function main(): Promise<void> {
  // ── 1. Validate environment ──────────────────────────────────
  const env = loadEnv(fanOutEnvSchema)

  // ── 2. Init shared Redis (app commands) ──────────────────────
  initRedis(env.REDIS_URL)

  // ── 3. Register DB pool teardown with the shared shutdown hook
  registerDbDisconnect(disconnectPool)

  // ── 4. Start fan-out worker ───────────────────────────────────
  const { worker } = createFanOutWorker(env.REDIS_URL, env.FAN_OUT_CONCURRENCY)

  console.log('[fan-out] Worker running. Press Ctrl-C to stop.')

  // ── 5. Graceful shutdown ──────────────────────────────────────
  let isShuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true

    console.log(`[fan-out] Shutdown triggered by ${signal}`)

    const watchdog = setTimeout(() => {
      console.error('[fan-out] Graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, 30_000)
    watchdog.unref()

    // Drain active jobs first — don't interrupt mid-fan-out
    await worker.close()
    console.log('[fan-out] Worker drained')

    await closeRedis()
    await disconnectDb()

    clearTimeout(watchdog)
    console.log('[fan-out] Shut down cleanly')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))

  process.on('unhandledRejection', reason => {
    console.error('[fan-out] Unhandled rejection:', reason)
    shutdown('unhandledRejection').finally(() => process.exit(1))
  })

  process.on('uncaughtException', err => {
    console.error('[fan-out] Uncaught exception:', err)
    shutdown('uncaughtException').finally(() => process.exit(1))
  })
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
