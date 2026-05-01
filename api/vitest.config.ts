import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Test files share a single Postgres `dashboard_test` DB
    // (see db/README.md), so they cannot truly run in parallel —
    // beforeEach TRUNCATEs would race.
    fileParallelism: false,
  },
})
