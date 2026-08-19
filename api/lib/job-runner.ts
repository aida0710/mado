import type { JobProgress, JobStore } from './jobs.js'

// ジョブの実行ループ (spec: 2026-08-18-job-queue-design.md)。
// SQL は jobs.ts に閉じており、ここは「claim → ハンドラ → 結果保存」の
// 制御フローと、進捗の間引き・キャンセルの伝播だけを持つ。

export interface JobContext {
  payload: unknown
  /** canceled になったら abort される。長い処理はこれを見て抜ける。 */
  signal: AbortSignal
  /** 呼び放題。書き込みは progressIntervalMs に間引かれる。 */
  setProgress(p: JobProgress): void
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>

export interface JobRunnerDeps {
  store: JobStore
  /** kind → handler。新しいジョブ種別はここに 1 行足す。 */
  handlers: Record<string, JobHandler>
  /** テスト用の時計。 */
  now?: () => number
  /** 進捗の書き込み間隔。既定 2 秒。 */
  progressIntervalMs?: number
  /** キャンセル確認の間隔。既定 2 秒。 */
  cancelCheckIntervalMs?: number
}

export function createJobRunner(deps: JobRunnerDeps): { runOnce(): Promise<boolean> } {
  const now = deps.now ?? ((): number => Date.now())
  const progressInterval = deps.progressIntervalMs ?? 2000
  const cancelInterval = deps.cancelCheckIntervalMs ?? 2000

  return {
    /** queued を 1 件処理する。処理したら true、無ければ false。 */
    async runOnce() {
      const job = await deps.store.claim()
      if (!job) return false

      const handler = deps.handlers[job.kind]
      if (!handler) {
        await deps.store.fail(job.id, `未登録のジョブ種別です: ${job.kind}`)
        return true
      }

      const ac = new AbortController()
      let lastProgressAt = -Infinity
      let lastCancelCheckAt = -Infinity

      const ctx: JobContext = {
        payload: job.payload,
        signal: ac.signal,
        setProgress(p) {
          const t = now()
          if (t - lastProgressAt >= progressInterval) {
            lastProgressAt = t
            // 進捗は補助情報。書けなくても処理は続ける。
            void deps.store.heartbeat(job.id, p).catch(() => {})
          }
          if (t - lastCancelCheckAt >= cancelInterval) {
            lastCancelCheckAt = t
            void deps.store.isCanceled(job.id)
              .then(c => { if (c) ac.abort() })
              .catch(() => {})
          }
        },
      }

      try {
        const result = await handler(ctx)
        // キャンセルされていたら finish しない (status は既に canceled)。
        if (!ac.signal.aborted) await deps.store.finish(job.id, result ?? null)
      } catch (e) {
        if (!ac.signal.aborted) await deps.store.fail(job.id, (e as Error).message)
      }
      return true
    },
  }
}
