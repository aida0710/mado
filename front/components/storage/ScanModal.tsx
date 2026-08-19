// ディレクトリ配下のオブジェクト数・サイズを見るモーダル
// (spec: 2026-08-18-directory-scan-design.md)。
//
// 走査はキューで走るので、モーダルを閉じても止まらない。閉じて後から見に来れば
// 結果がある。止めたいときは「中止」を押す。
//
// 進捗にパーセンテージは出ない。S3 には件数を返す API が無く、初回の走査では
// 分母が原理的に出せないため。「123,456 件を走査中」と実数だけを出す。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api/client'
import { ScanResult as ScanResultSchema, type ScanResult } from '../../lib/api/types'
import { fmtSize } from '../../lib/format'

interface Props {
  connId: string
  bucket: string
  prefix: string
  onClose: () => void
}

const POLL_MS = 1000

export function ScanModal({ connId, bucket, prefix, onClose }: Props) {
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
          setResult(ScanResultSchema.parse(job.result))
          setScannedAt(job.finishedAt ?? null)
          setRunning(false)
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
  }, [jobId, running])

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
      <div className="modal" role="dialog" aria-modal="true" aria-label="配下の集計">
        <h3>配下の集計</h3>
        <p className="font-mono text-[12px] text-ink-7 m-0 mb-4">
          {bucket} / {prefix || '(バケット直下)'}
        </p>

        {running && (
          <p className="text-[13px] text-ink-9 flex items-center gap-3">
            <span className="cache-banner__dot" aria-hidden />
            {scanned.toLocaleString()} 件を走査中…
            <button type="button" className="ghost" onClick={cancel}>中止</button>
          </p>
        )}
        {canceled && <p className="text-[13px] text-ink-7">中止しました。</p>}
        {error && <p className="error">{error}</p>}

        {loaded && !result && !running && (
          <p className="text-[13px] text-ink-7">まだ走査していません。</p>
        )}

        {result && (
          <>
            <p className="text-[15px]">
              <strong>{result.objectCount.toLocaleString()}</strong> 件 /{' '}
              <strong>{fmtSize(result.totalBytes)}</strong>
              {scannedAt && (
                <span className="ml-2 text-[12px] text-ink-7">
                  {new Date(scannedAt).toLocaleString('ja-JP')} に走査
                </span>
              )}
            </p>
            {result.partial && (
              <p className="text-[12px] text-ink-7">
                走査中にエラーが出たため、集計は途中までです。
              </p>
            )}
            {result.children.length > 0 && (
              <table className="w-full text-[13px] mt-3">
                <thead>
                  <tr>
                    <th className="text-left">サブディレクトリ</th>
                    <th className="text-right">件数</th>
                    <th className="text-right">サイズ</th>
                  </tr>
                </thead>
                <tbody>
                  {result.children.map(ch => (
                    <tr key={ch.name}>
                      <td className="font-mono">{ch.name}</td>
                      <td className="text-right tabular-nums">{ch.objectCount.toLocaleString()}</td>
                      <td className="text-right tabular-nums">{fmtSize(ch.totalBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {!running && (
          <button type="button" className="ghost mt-4" onClick={start}>
            {result ? '再走査する' : '走査する'}
          </button>
        )}
      </div>
    </div>
  )
}
