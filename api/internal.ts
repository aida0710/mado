// api/internal.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { createStorageFactory } from './storage.js'
import { requireSafeOrigin } from './lib/originCheck.js'
import { requireCapability } from './lib/capabilityGuard.js'
import type { Capability } from './storage.js'
import { explainStorageError } from './lib/storageError.js'
import { mountStorageListRoutes } from './routes/storage-list.js'
import { createResponseCache } from './lib/storage-cache.js'
import { createJobStore } from './lib/jobs.js'
import { createBucketSettings } from './lib/bucket-settings.js'
import { mountJobRoutes } from './routes/jobs.js'
import { mountStorageScanRoutes } from './routes/storage-scan.js'
import { mountStorageReadmeRoutes } from './routes/storage-readme.js'
import { mountStoragePreviewRoutes } from './routes/storage-preview.js'
import { mountStorageMediaRoutes } from './routes/storage-media.js'
import { mountStorageFavoritesRoutes } from './routes/storage-favorites.js'
import { mountConnectionsRoutes } from './routes/connections.js'
import { mountNotesRoutes } from './routes/notes.js'
import { mountStorageTagsRoutes } from './routes/storage-tags.js'
import { mountSettingsRoutes } from './routes/settings.js'

// LAN ダッシュボード: 1 つのストリーム teardown 起因の未捕捉例外で全ユーザーの
// リクエストを巻き添えにしない。root cause は都度直す前提の最後の砦 (ログは大声で)。
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION (kept alive)', err))
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION (kept alive)', err))

const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const crypto = createCrypto(env.ENCRYPTION_KEY)
const storageFactory = createStorageFactory({ pools, crypto })

// 応答キャッシュは書き込みを伴うので rw プールを使う。書き込み先は
// storage_response_cache の 1 テーブルのみ (spec の「ロールについての判断」)。
const responseCache = createResponseCache(pools.rw)
const jobStore = createJobStore(pools)
const bucketSettings = createBucketSettings(pools)

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

const api = new Hono()
api.use('*', requireSafeOrigin(env.ALLOWED_ORIGINS))

// 接続ごとの権限ガード。「どのエンドポイントがどの権限に属するか」をここ 1 箇所に
// 集約する (ルートハンドラ側には権限の知識を持たせない)。
// Hono は登録順に実行するので、必ずルートの mount より前に登録すること。
const cap = (k: Capability) => requireCapability(k, storageFactory.getConnectionConfig)
api.use('/storage/:connId/buckets',           cap('list'))
api.use('/storage/:connId/list',              cap('list'))
api.use('/storage/:connId/preview/text',      cap('preview'))
api.use('/storage/:connId/preview/image',     cap('preview'))
api.use('/storage/:connId/preview/audio',     cap('preview'))
api.use('/storage/:connId/preview/raw',       cap('download'))
api.use('/storage/:connId/preview/tar',       cap('archive'))
api.use('/storage/:connId/preview/tar-entry', cap('archive'))
api.use('/storage/:connId/media/analyze',     cap('audioInfo'))
api.use('/storage/:connId/media/spectrogram', cap('audioSpectrogram'))
// README は同じパスで GET = 読み込み / PUT = 編集。メソッドごとに権限が違う。
api.on('GET', '/storage/:connId/readme',      cap('readmeRead'))
api.on('PUT', '/storage/:connId/readme',      cap('readmeWrite'))
api.use('/storage/:connId/readme/history',    cap('readmeRead'))
api.use('/storage/:connId/readme/history/:id', cap('readmeRead'))
api.use('/storage/:connId/readmes/search',    cap('readmeRead'))

mountConnectionsRoutes(api, {
  pools,
  crypto,
  invalidate: (id: string) => {
    storageFactory.invalidate(id)
    // endpoint や list_objects_version が変われば応答が変わるので、
    // この接続の一覧キャッシュは全部捨てる。await しないのは既存の
    // invalidate が同期シグネチャのため (失敗は内部でログ済み)。
    void responseCache.invalidateConnection(id)
  },
})
mountStorageListRoutes(api, {
  getStorage: storageFactory.getStorage,
  getConnectionConfig: storageFactory.getConnectionConfig,
  cache: responseCache,
})
mountStorageReadmeRoutes(api, { getStorage: storageFactory.getStorage, pools, cache: responseCache })
mountStoragePreviewRoutes(api, { getStorage: storageFactory.getStorage, env })
mountStorageMediaRoutes(api, {
  getStorage: storageFactory.getStorage,
  pools,
  env,
})
mountJobRoutes(api, { store: jobStore })
mountStorageScanRoutes(api, { store: jobStore, bucketSettings })
mountStorageFavoritesRoutes(api, { pools })
mountSettingsRoutes(api, { pools })
mountNotesRoutes(api, { pools })
mountStorageTagsRoutes(api, { pools })

app.route('/api/internal', api)

// 未 catch のエラーをユーザフレンドリーに翻訳する。S3 系は 502 + 短い説明、
// それ以外は内部 error をログに出して 500 + "internal error" だけ返す
// (raw error.message を漏らさない)。
app.onError((err, c) => {
  const explained = explainStorageError(err)
  if (explained) {
    return c.json({ error: explained.message }, explained.status)
  }
  console.error('unhandled error', err)
  return c.json({ error: 'internal error' }, 500)
})

const server = serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(
    `internal listening on http://localhost:${info.port}; ` +
    `allowed origins: ${env.ALLOWED_ORIGINS.join(', ')}`,
  )
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
