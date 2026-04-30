import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Test files share a single Postgres `dashboard_test` DB (see
    // server/migrations/README.md), so they cannot truly run in parallel —
    // the `beforeEach` TRUNCATEs would race. Tests within a file still
    // run sequentially as usual.
    fileParallelism: false,
  },
})
