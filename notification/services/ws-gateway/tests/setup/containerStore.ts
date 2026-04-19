// ─────────────────────────────────────────────────────────────────
// Container store — shared between globalSetup and globalTeardown
//
// globalSetup and globalTeardown run in separate Node.js processes
// in Jest. We persist container references using the Jest global
// store (global.__TESTCONTAINERS__) so teardown can stop what
// setup started.
// ─────────────────────────────────────────────────────────────────

import type { StartedPostgreSqlContainer } from 'testcontainers'
import type { StartedRedisContainer }      from 'testcontainers'

declare global {
  // eslint-disable-next-line no-var
  var __TESTCONTAINERS__: {
    postgres?: StartedPostgreSqlContainer
    redis?:    StartedRedisContainer
  }
}

export function setContainers(containers: {
  postgres: StartedPostgreSqlContainer
  redis:    StartedRedisContainer
}): void {
  global.__TESTCONTAINERS__ = containers
}

export function getContainers() {
  return global.__TESTCONTAINERS__ ?? {}
}
