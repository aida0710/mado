// ディレクトリ配下のオブジェクト数・サイズの内訳
// (spec: 2026-08-18-directory-scan-design.md)。
//
// 走査はキューで走るので、モーダルを閉じても止まらない。閉じて後から見に来れば
// 結果がある。止めたいときは「中止」を押す。
//
// 進捗にパーセンテージは出ない。S3 には件数を返す API が無く、初回の走査では
// 分母が原理的に出せないため。「112,000 件」と実数だけを出す。
//
// 走査中と結果で骨格 (.scan-figures) を保つ。完了時に「走査済み」が
// 「オブジェクト / 合計サイズ」へ置き換わるだけで、レイアウトが飛ばない。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api/client'
import { ScanResult as ScanResultSchema, type ScanResult } from '../../lib/api/types'
import { fmtCacheAge, fmtSize } from '../../lib/format'

interface Props {
  connId: string
  bucket: string
  prefix: string
  onClose: () => void
  /** 走査が完了したとき。呼び出し側が要約表示を更新するのに使う。 */
  onResult?: (r: ScanResult) => void
}

const POLL_MS = 1000

/** 内訳の 1 行。棒はサイズ基準 (最大値を 100%)。件数より偏りが実務に効く。 */
function Breakdown({ title, rows }: {
  title: string
  rows: Array<{ label: string; objectCount: number; totalBytes: number }>
}) {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map(r => r.totalBytes), 1)
  return (
    <div className="scan-brk">
      <span className="scan-brk__k">{title}</span>
      {rows.map(r => (
        <div key={r.label}>
          <div className="scan-row">
            <span className="scan-row__nm">{r.label}</span>
            <span className="scan-row__ct">{r.objectCount.toLocaleString()}</span>
            <span className="scan-row__sz">{fmtSize(r.totalBytes)}</span>
          </div>
          <div className="scan-meter">
            <i style={{ width: `${Math.max(1, (r.totalBytes / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ScanModal({ connId, bucket, prefix, onClose, onResult }: Props) {
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [canceled, setCanceled] = useState(false)
  const [scanned, setScanned] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const timer = useRef<number | null>(null)

  // 開いた直後に保存済みの結果を引く。
  useEffect(() => {
    let cancelled = false
    api.latestScan(connId, bucket, prefix)
      .then(job => {
        if (cancelled || !job) return
        setResult(ScanResultSchema.parse(job.result))
        setScannedAt(job.finishedAt ?? null)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [connId, bucket, prefix])

  // 実行中だけポーリングする。終端状態で止める。
  useEffect(() => {
    if (jobId === null || !running) return
    const tick = (): void => {
      api.getJob(jobId).then(job => {
        if (job.progress && job.progress.kind === 'count') setScanned(job.progress.done)
        if (job.status === 'done') {
          const r = ScanResultSchema.parse(job.result)
          setResult(r)
          setScannedAt(job.finishedAt ?? null)
          setRunning(false)
          onResult?.(r)
        } else if (job.status === 'error') {
          setError(job.error ?? '走査に失敗しました')
          setRunning(false)
        } else if (job.status === 'canceled') {
          setCanceled(true)
          setRunning(false)
        }
      }).catch(() => {})
    }
    timer.current = window.setInterval(tick, POLL_MS)
    tick()
    return () => { if (timer.current != null) window.clearInterval(timer.current) }
  }, [jobId, running, onResult])

  const start = useCallback(() => {
    setError(null)
    setCanceled(false)
    setScanned(0)
    setRunning(true)
    api.startScan(connId, bucket, prefix)
      .then(r => setJobId(r.jobId))
      .catch((e: Error) => { setError(e.message); setRunning(false) })
  }, [connId, bucket, prefix])

  const cancel = useCallback(() => {
    if (jobId !== null) api.cancelJob(jobId).catch(() => {})
  }, [jobId])

  return (
    <div className="modal-backdrop" role="presentation">
      <button
        type="button"
        className="modal-backdrop__close-overlay"
        tabIndex={-1}
        aria-label="閉じる"
        onClick={onClose}
      />
      <div className="modal scan-modal" role="dialog" aria-modal="true" aria-label="配下の集計">
        <h3>配下の集計</h3>
        <p className="scan-modal__path">{bucket} / {prefix || '(バケット直下)'}</p>

        {/* 走査中も結果も同じ枠。完了時にレイアウトが飛ばない。 */}
        {(running || result) && (
          <div className="scan-figures">
            {running ? (
              <div className="scan-fig">
                <span className="scan-fig__k">走査済み</span>
                <span className="scan-fig__v">
                  {scanned.toLocaleString()}<small>件</small>
                </span>
              </div>
            ) : result && (
              <>
                <div className="scan-fig">
                  <span className="scan-fig__k">オブジェクト</span>
                  <span className="scan-fig__v">
                    {result.objectCount.toLocaleString()}<small>件</small>
                  </span>
                </div>
                <div className="scan-fig">
                  <span className="scan-fig__k">合計サイズ</span>
                  <span className="scan-fig__v">{fmtSize(result.totalBytes)}</span>
                </div>
              </>
            )}
          </div>
        )}

        {running && (
          <div className="cache-banner__track" style={{ marginTop: 14 }}>
            <div role="progressbar" aria-label="走査中" className="cache-banner__bar" />
          </div>
        )}

        {!running && result && (
          <>
            {result.partial && (
              <p className="scan-modal__note">
                走査中にエラーが出たため、集計は途中までです。
              </p>
            )}
            <Breakdown
              title="サブディレクトリ"
              rows={result.children.map(c => ({
                label: c.name, objectCount: c.objectCount, totalBytes: c.totalBytes,
              }))}
            />
            <Breakdown
              title="拡張子"
              rows={result.extensions.map(e => ({
                label: e.ext, objectCount: e.objectCount, totalBytes: e.totalBytes,
              }))}
            />
          </>
        )}

        {canceled && <p className="scan-modal__note">中止しました。</p>}
        {error && <p className="error">{error}</p>}
        {loaded && !result && !running && !error && (
          <p className="scan-modal__note">まだ走査していません。</p>
        )}

        <div className="scan-modal__foot">
          {running ? (
            <>
              <button type="button" className="ghost" onClick={cancel}>中止</button>
              <span className="cache-banner__dot" aria-hidden />
              <span>走査中…</span>
            </>
          ) : (
            <>
              <button type="button" className="ghost" onClick={start}>
                {result ? '↻ 再走査' : '走査する'}
              </button>
              {scannedAt && (
                <span>{fmtCacheAge(new Date(scannedAt))} に走査</span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
