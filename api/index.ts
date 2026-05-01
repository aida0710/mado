import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.js'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { createStorageFactory } from './storage.js'
import { mountMetricsRoutes } from './routes/metrics.js'
import { mountSqlRoutes } from './routes/sql.js'
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
mountMetricsRoutes(app, { pools, writeToken: env.WRITE_TOKEN })
mountSqlRoutes(app, { pools, writeToken: env.WRITE_TOKEN })
mountConnectionsRoutes(app, {
  pools,
  crypto,
  invalidate: storageFactory.invalidate,
})
mountStorageListRoutes(app, { getStorage: storageFactory.getStorage })
mountStorageReadmeRoutes(app, { getStorage: storageFactory.getStorage, pools })
mountStoragePreviewRoutes(app, { getStorage: storageFactory.getStorage, env })
mountStorageFavoritesRoutes(app, { pools })
mountNotesRoutes(app, { pools })
mountSettingsRoutes(app, { pools })

// Frontend static dist lives at <repo>/front/dist (workspace layout).
// Resolve relative to this file so dev (tsx, /api/index.ts) and prod
// (node, /api/dist/index.js) both find it.
const here = dirname(fileURLToPath(import.meta.url))
const isCompiled = here.endsWith(`${'/'}dist`)
const distDir = isCompiled
  ? resolve(here, '..', '..', 'front', 'dist')
  : resolve(here, '..', 'front', 'dist')
const distIndex = resolve(distDir, 'index.html')
if (existsSync(distIndex)) {
  app.use('/*', serveStatic({ root: distDir }))
  // SPA fallback: any unmatched GET returns index.html so client-side
  // routes (e.g. /storage/<bucket>/<prefix>) work on direct load and reload.
  // API routes were registered earlier; Hono dispatches in registration
  // order, so they take precedence.
  const indexHtml = readFileSync(distIndex, 'utf-8')
  app.get('*', c => c.html(indexHtml))
}

const server = serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(`server listening on http://localhost:${info.port}`)
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
