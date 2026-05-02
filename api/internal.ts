// api/internal.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { createStorageFactory } from './storage.js'
import { requireSafeOrigin } from './lib/originCheck.js'
import { mountMetricsReadRoutes } from './routes/metrics.js'
import { mountStorageListRoutes } from './routes/storage-list.js'
import { mountStorageReadmeRoutes } from './routes/storage-readme.js'
import { mountStoragePreviewRoutes } from './routes/storage-preview.js'
import { mountStorageFavoritesRoutes } from './routes/storage-favorites.js'
import { mountConnectionsRoutes } from './routes/connections.js'
import { mountNotesRoutes } from './routes/notes.js'
import { mountSettingsRoutes } from './routes/settings.js'

const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const crypto = createCrypto(env.ENCRYPTION_KEY)
const storageFactory = createStorageFactory({ pools, crypto })

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

const api = new Hono()
api.use('*', requireSafeOrigin(env.ALLOWED_ORIGINS))
mountMetricsReadRoutes(api, { pools })
mountConnectionsRoutes(api, {
  pools,
  crypto,
  invalidate: storageFactory.invalidate,
})
mountStorageListRoutes(api, { getStorage: storageFactory.getStorage })
mountStorageReadmeRoutes(api, { getStorage: storageFactory.getStorage, pools })
mountStoragePreviewRoutes(api, { getStorage: storageFactory.getStorage, env })
mountStorageFavoritesRoutes(api, { pools })
mountNotesRoutes(api, { pools })
mountSettingsRoutes(api, { pools })

app.route('/api/internal', api)

const server = serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(`internal listening on http://localhost:${info.port}`)
})

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  setTimeout(() => process.exit(1), 10_000).unref()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await storageFactory.close()
  await closePools(pools)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export { app, pools, storageFactory }
