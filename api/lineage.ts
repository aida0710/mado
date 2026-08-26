import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'
import { closePools, createPools } from './db.js'
import { createAuditWriter } from './lib/audit.js'
import { createServiceAccountStore } from './lib/auth-api-keys.js'
import { createRegistryClient } from './lib/registry-client.js'
import { mountOpenLineageRoutes } from './routes/openlineage.js'

const env = loadEnv()
if (!env.DATASET_REGISTRY_URL || !env.DATASET_REGISTRY_TOKEN) {
  throw new Error('DATASET_REGISTRY_URL and DATASET_REGISTRY_TOKEN are required by api-lineage')
}

const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const accounts = createServiceAccountStore(pools.rw)
const audit = createAuditWriter(pools.rw)
const registry = createRegistryClient({
  baseUrl: env.DATASET_REGISTRY_URL,
  token: env.DATASET_REGISTRY_TOKEN,
})

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

const api = new Hono()
mountOpenLineageRoutes(api, {
  auth: {
    authenticate: token => accounts.authenticate(token),
    async recordUse(event) {
      const outcome = event.outcome === 'accepted'
        ? 'success'
        : event.outcome === 'upstream_error' ? 'failure' : 'denied'
      await audit.write({
        actor: {
          type: 'service_account',
          serviceAccountId: event.principal.serviceAccountId,
        },
        action: 'lineage.ingest',
        outcome,
        resourceType: 'openlineage_run',
        resourceId: event.runId,
        details: {
          keyId: event.principal.keyId,
          jobNamespace: event.jobNamespace,
          jobName: event.jobName,
          ingestOutcome: event.outcome,
        },
      })
    },
  },
  registry,
  bodyLimitBytes: env.OPENLINEAGE_BODY_LIMIT_BYTES,
})
app.route('/api', api)

app.onError((error, c) => {
  console.error('unhandled lineage API error', error)
  return c.json({ error: 'internal error' }, 500)
})

const server = serve({ fetch: app.fetch, port: env.LINEAGE_API_PORT }, info => {
  console.log(`lineage API listening on http://localhost:${info.port}`)
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

export { app }
