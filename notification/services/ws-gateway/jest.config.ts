import type { Config } from 'jest'

const config: Config = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  rootDir:             '../..',          // notification root so ts-jest sees tsconfig.base.json
  testMatch:           ['**/services/ws-gateway/tests/**/*.test.ts'],
  globalSetup:         './services/ws-gateway/tests/setup/globalSetup.ts',
  globalTeardown:      './services/ws-gateway/tests/setup/globalTeardown.ts',
  testTimeout:         30_000,
  // Prevent tests from running in parallel — they share containers
  maxWorkers:          1,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        extends:           './tsconfig.base.json',
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@notification-engine/shared': ['packages/shared/src/index.ts'],
          },
        },
      },
    }],
  },
  moduleNameMapper: {
    '^@notification-engine/shared$': '<rootDir>/packages/shared/src/index.ts',
  },
  collectCoverageFrom: [
    'connection/**/*.ts',
    'lib/**/*.ts',
    'processors/**/*.ts',
    'repositories/**/*.ts',
    'services/**/*.ts',
    '!services/ws-gateway/**',
    'workers/**/*.ts',
    '!**/*.d.ts',
  ],
}

export default config
