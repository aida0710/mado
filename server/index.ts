import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'
import { createPools, closePools } from './db.js'
import { mountHpcRoutes } from './routes/hpc.js'
import { mountSqlRoutes } from './routes/sql.js'

const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const app = new Hono()

app.use('*', logger())
app.get('/healthz', c => c.text('ok'))
mountHpcRoutes(app, { pools, writeToken: env.WRITE_TOKEN })
mountSqlRoutes(app, { pools, writeToken: env.WRITE_TOKEN })

const server = serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(`server listening on http://localhost:${info.port}`)
})

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  setTimeout(() => process.exit(1), 10_000).unref()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await closePools(pools)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export { app, pools }
