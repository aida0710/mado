// api/worker.ts — media-worker コンテナのエントリポイント。
//   ・内部 HTTP (compose ネットワーク内のみ): POST /analyze で同期解析
// api-internal と同じコードベース / .env を共有し、compose で別サービスとして起動。
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { createStorageFactory } from './storage.js'
import { MediaAnalyzeError } from './lib/media-analyze.js'
import { createMediaService, type AnalyzeRequest } from './lib/media-service.js'

// LAN ダッシュボード: 1 つのストリーム teardown 起因の未捕捉例外で全ユーザーの
// リクエストを巻き添えにしない。root cause は都度直す前提の最後の砦 (ログは大声で)。
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION (kept alive)', err))
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION (kept alive)', err))

const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const crypto = createCrypto(env.ENCRYPTION_KEY)
const storageFactory = createStorageFactory({ pools, crypto })
const service = createMediaService({
  pools,
  getStorage: storageFactory.getStorage,
  getConnectionConfig: storageFactory.getConnectionConfig,
  env,
})

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

app.post('/analyze', async c => {
  const req = (await c.req.json()) as AnalyzeRequest
  if (!req.connId || !req.bucket || !req.key || !req.etag) {
    return c.json({ error: 'connId, bucket, key, etag required' }, 400)
  }
  try {
    // クライアント (api 経由でブラウザ) が切断したら解析を中断して ffmpeg を kill
    const result = await service.analyzeOne(req, c.req.raw.signal)
    return c.json(result)
  } catch (e) {
    if (e instanceof MediaAnalyzeError) {
      return c.json({ error: `解析できませんでした: ${e.message}` }, 422)
    }
    throw e
  }
})

app.onError((err, c) => {
  console.error('worker unhandled error', err)
  return c.json({ error: 'internal error' }, 500)
})

const server = serve({ fetch: app.fetch, port: env.MEDIA_WORKER_PORT }, info => {
  console.log(`media-worker listening on http://localhost:${info.port}`)
})

const cleanupTimer = setInterval(() => {
  service.cleanup().catch(e => console.error('cleanup error', e))
}, 60 * 60 * 1000)
cleanupTimer.unref()

let shuttingDown = false
const shutdown = async (): Promise<void> => {
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
