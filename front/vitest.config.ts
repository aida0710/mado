import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['front/**/*.test.{ts,tsx}', 'api/**/*.test.ts'],
    // Test files share a single Postgres `dashboard_test` DB
    // (see db/README.md), so they cannot truly run
    // in parallel — beforeEach TRUNCATEs would race.
    fileParallelism: false,
  },
})
