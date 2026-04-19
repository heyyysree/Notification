import {
  PostgreSqlContainer,
  RedisContainer,
} from 'testcontainers'
import { readFileSync } from 'fs'
import { join }         from 'path'
import { setContainers } from './containerStore'

// ─────────────────────────────────────────────────────────────────
// Jest global setup — runs ONCE before all test suites
//
// Starts real PostgreSQL 16 and Redis 7 containers, runs all DB
// migrations, and injects connection strings into process.env.
// Tests never connect to localhost directly — they always use the
// container-provided URLs.
//
// Why real containers?
//   - No mocks → tests prove actual SQL + Redis interactions work
//   - Identical to CI (same images, same port randomisation)
//   - Testcontainers handles image pull caching — subsequent runs
//     are fast once images are cached.
//
// TESTCONTAINERS_RYUK_DISABLED=true in CI skips the Ryuk reaper
// container, which requires a Docker socket that may be restricted.
// ─────────────────────────────────────────────────────────────────

export default async function globalSetup(): Promise<void> {
  console.log('\n[test-setup] Starting PostgreSQL + Redis containers…')

  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('notifications_test')
      .withUsername('test')
      .withPassword('test')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ])

  console.log(`[test-setup] PostgreSQL ready at ${postgres.getConnectionUri()}`)
  console.log(`[test-setup] Redis ready at redis://${redis.getHost()}:${redis.getMappedPort(6379)}`)

  // ── Run migrations ───────────────────────────────────────────
  const { Client } = await import('pg')
  const client = new Client({ connectionString: postgres.getConnectionUri() })
  await client.connect()

  const migrationPath = join(__dirname, '../../../../db/migrations/001_initial_schema.sql')
  const migration = readFileSync(migrationPath, 'utf-8')
  await client.query(migration)
  await client.end()

  console.log('[test-setup] Migrations applied')

  // ── Persist for teardown ──────────────────────────────────────
  setContainers({ postgres, redis })

  // ── Inject env for all test workers ──────────────────────────
  process.env['DATABASE_URL'] = postgres.getConnectionUri()
  process.env['REDIS_URL']    = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`
  process.env['NODE_ENV']     = 'test'
  process.env['LOG_LEVEL']    = 'warn'    // keep test output clean
  process.env['WS_TOKEN_SECRET'] = 'test-secret-at-least-32-chars-long!!'

  // Expose on global so Jest workers inherit via testEnvironmentOptions
  ;(global as Record<string, unknown>)['__DATABASE_URL__'] = process.env['DATABASE_URL']
  ;(global as Record<string, unknown>)['__REDIS_URL__']    = process.env['REDIS_URL']
}
