import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.js'],
      setupFiles: ['./vitest.setup.ts']
    }
  },
  {
    test: {
      name: 'integration',
      include: ['tests/api/**/*.test.js'],
      setupFiles: ['./vitest.setup.ts'],
      // Every suite truncates ~50 tables and replays seed.sql in beforeAll,
      // which blows past the 10s default against a containerised MySQL.
      hookTimeout: 180_000,
      testTimeout: 30_000,
      pool: 'forks',
      poolOptions: {
        forks: { singleFork: true }
      }
    }
  }
])
