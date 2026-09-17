// api/worker.ts — media-worker コンテナのエントリポイント。
//   ・内部 HTTP (compose ネットワーク内のみ): POST /analyze で同期解析
// api-internal と同じコードベース / .env を共有し、compose で別サービスとして起動。
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
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
import { createPricingStore } from './lib/pricing-store.js'
import { createPricingRefreshHandler } from './lib/pricing-refresh-handler.js'
import { PRICING_REFRESH_KIND } from './routes/pricing.js'
import { requestLogger } from './lib/request-logger.js'
import { createCapacityStore } from './lib/capacity-store.js'
import { createCapacityScheduler } from './lib/capacity-scheduler.js'
import { listStorageBucketNames } from './lib/storage-buckets.js'

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
const capacityStore = createCapacityStore(pools)
const jobRunner = createJobRunner({
  store: jobStore,
  // 新しいジョブ種別はここに 1 行足す。
  handlers: {
    [SCAN_KIND]: createScanHandler({
      getStorage: storageFactory.getStorage,
      getConnectionConfig: storageFactory.getConnectionConfig,
      capacity: capacityStore,
    }),
    // 料金カタログの取得。**外部 (AWS) を叩く唯一のジョブ**。
    // 外に出られない環境では失敗するが、その場合も同梱カタログで見積もりは出る。
    [PRICING_REFRESH_KIND]: createPricingRefreshHandler({
      store: createPricingStore(pools),
    }),
  },
})

const app = new Hono()
app.use('*', requestLogger())
app.get('/healthz', c => c.text('ok'))

app.post('/analyze', async c => {
  const req = (await c.req.json()) as AnalyzeRequest
  if (!req.connectionId || !req.bucket || !req.key || !req.etag) {
    return c.json({ error: 'connectionId, bucket, key, etag required' }, 400)
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

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// media cache の掃除は 1 時間おき。cache の TTL は日単位なので、これより細かくしても意味がない。
const MEDIA_CLEANUP_INTERVAL_MS = HOUR_MS
// queued が無いときの待ち。短いほど投入から着手までが速いが、DB を空回りで叩く回数が増える。
const JOB_IDLE_WAIT_MS = 2_000
// DB 未到達などでループが失敗したときの待ち。起動直後の DB 未起動でも worker を殺さず
// 待つ方針なので、連続失敗で log を埋めない程度に空ける。
const JOB_ERROR_WAIT_MS = 5_000
// heartbeat が止まった running job を拾い直す間隔と、stale とみなす経過秒。
const STALE_JOB_CHECK_INTERVAL_MS = 60_000
const STALE_JOB_AFTER_SEC = 120
// 同じ job を何度も拾い直さない上限。poison job (毎回 crash する) を止めるため。
const STALE_JOB_MAX_ATTEMPTS = 3
// 終了済み job と容量 snapshot の保持期間。最新の done は結果ストアを兼ねるので残る。
const FINISHED_JOB_KEEP_DAYS = 7
const CAPACITY_SNAPSHOT_KEEP_DAYS = 400

const cleanupTimer = setInterval(() => {
  service.cleanup().catch(e => console.error('cleanup error', e))
}, MEDIA_CLEANUP_INTERVAL_MS)
cleanupTimer.unref()

// ── ジョブループ ──
let jobLoopStopping = false
async function jobLoop(): Promise<void> {
  for (;;) {
    if (jobLoopStopping) return
    try {
      const ran = await jobRunner.runOnce()
      if (!ran) await new Promise(r => setTimeout(r, JOB_IDLE_WAIT_MS))
    } catch (e) {
      console.error('job loop error', e)
      await new Promise(r => setTimeout(r, JOB_ERROR_WAIT_MS))
    }
  }
}
void jobLoop()

const staleTimer = setInterval(() => {
  jobStore.requeueStale(STALE_JOB_AFTER_SEC, STALE_JOB_MAX_ATTEMPTS)
    .catch(e => console.error('requeueStale error', e))
}, STALE_JOB_CHECK_INTERVAL_MS)
staleTimer.unref()

const pruneTimer = setInterval(() => {
  Promise.all([jobStore.pruneFinished(FINISHED_JOB_KEEP_DAYS), capacityStore.prune(CAPACITY_SNAPSHOT_KEEP_DAYS)])
    .catch(e => console.error('daily prune error', e))
}, DAY_MS)
pruneTimer.unref()
void jobStore.pruneFinished(FINISHED_JOB_KEEP_DAYS).catch(() => {})

// 追跡を明示的に有効化したconnectionの全bucketを定期走査する。storage.scanと同じ
// dedup keyを使うため、手動走査と重なってもS3全走査は1本に合流する。
const capacityScheduler = createCapacityScheduler({
  capacity: capacityStore,
  jobs: jobStore,
  getConnectionConfig: storageFactory.getConnectionConfig,
  listBuckets: connectionId => listStorageBucketNames(storageFactory.getStorage, connectionId),
})
const capacityTimer = setInterval(() => {
  capacityScheduler.runOnce().catch(e => console.error('capacity scheduler error', e))
}, 60_000)
capacityTimer.unref()
void capacityScheduler.runOnce().catch(e => console.error('capacity scheduler startup error', e))
void capacityStore.prune(400).catch(() => {})

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  jobLoopStopping = true
  clearInterval(capacityTimer)
  setTimeout(() => process.exit(1), 10_000).unref()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await storageFactory.close()
  await closePools(pools)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
