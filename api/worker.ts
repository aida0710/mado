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
import { createJobStore } from './lib/jobs.js'
import { createJobRunner } from './lib/job-runner.js'
import { createScanHandler } from './lib/scan-handler.js'
import { SCAN_KIND } from './routes/storage-scan.js'

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

const jobStore = createJobStore(pools)
const jobRunner = createJobRunner({
  store: jobStore,
  // 新しいジョブ種別はここに 1 行足す。
  handlers: {
    [SCAN_KIND]: createScanHandler({
      getStorage: storageFactory.getStorage,
      getConnectionConfig: storageFactory.getConnectionConfig,
    }),
  },
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

// ── ジョブループ ──
// queued が無ければ 2 秒待つだけなので DB への負荷は無視できる。
// 起動直後に DB が未到達でも worker を殺さない (旧実装の方針を踏襲)。
let jobLoopStopping = false
async function jobLoop(): Promise<void> {
  for (;;) {
    if (jobLoopStopping) return
    try {
      const ran = await jobRunner.runOnce()
      if (!ran) await new Promise(r => setTimeout(r, 2000))
    } catch (e) {
      console.error('job loop error', e)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}
void jobLoop()

// worker が落ちたまま running で残ったジョブを拾い直す。
// attempts >= 3 のものは error に落として無限再投入を防ぐ。
const staleTimer = setInterval(() => {
  jobStore.requeueStale(120, 3).catch(e => console.error('requeueStale error', e))
}, 60_000)
staleTimer.unref()

// 完了ジョブの掃除。最新の done は結果ストアを兼ねるので残る。
const pruneTimer = setInterval(() => {
  jobStore.pruneFinished(7).catch(e => console.error('pruneFinished error', e))
}, 24 * 60 * 60 * 1000)
pruneTimer.unref()
void jobStore.pruneFinished(7).catch(() => {})

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  jobLoopStopping = true
  setTimeout(() => process.exit(1), 10_000).unref()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await storageFactory.close()
  await closePools(pools)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
