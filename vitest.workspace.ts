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
      pool: 'forks',
      poolOptions: {
        forks: { singleFork: true }
      }
    }
  }
])
