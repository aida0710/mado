import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'

const env = loadEnv()
const app = new Hono()

app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

const server = serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(`server listening on http://localhost:${info.port}`)
})

const shutdown = () => {
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export { app }
