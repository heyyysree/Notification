import { getContainers } from './containerStore'

export default async function globalTeardown(): Promise<void> {
  const { postgres, redis } = getContainers()

  await Promise.all([
    postgres?.stop(),
    redis?.stop(),
  ])

  console.log('\n[test-teardown] Containers stopped')
}
