// ディレクトリ配下のオブジェクト数・サイズの内訳
// (spec: 2026-08-18-directory-scan-design.md)。
//
// 走査はキューで走るので、ダイアログを閉じても止まらない。閉じて後から見に来れば
// 結果がある。止めたいときは「中止」を押す。
//
// 進捗にパーセンテージは出ない。S3 には件数を返す API が無く、初回の走査では
// 分母が原理的に出せないため。「112,000 件」と実数だけを出す。
//
// 走査中と結果で骨格 (.scan-figures) を保つ。完了時に「走査済み」が
// 「オブジェクト / 合計サイズ」へ置き換わるだけで、レイアウトが飛ばない。

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../../lib/api/client'
import { ScanResult as ScanResultSchema, type ScanResult } from '../../lib/api/types'
import { fmtCacheAge, fmtSize } from '../../lib/format'
import { Dialog } from '../Dialog'
import { EstimatePanel } from './EstimatePanel'

interface Props {
  connectionId: string
  bucket: string
  prefix: string
  onClose: () => void
  /** 走査が完了したとき。呼び出し側が要約表示を更新するのに使う。 */
  onResult?: (r: ScanResult) => void
}

const POLL_MS = 1000

/** 内訳の表。棒はサイズ基準 (最大値を 100%)。件数より偏りが実務に効く。 */
function Breakdown({ title, rows }: {
  title: string
  rows: Array<{ label: string; objectCount: number; totalBytes: number }>
}) {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map(r => r.totalBytes), 1)
  return (
    <div className="table-scroll">
      <table className="scan-table">
        <thead>
          <tr>
            <th scope="col">{title}</th>
            <th scope="col" className="numeric scan-col-count">件数</th>
            <th scope="col" className="numeric scan-col-size">サイズ</th>
            <th scope="col" className="scan-col-meter"><span className="sr-only">サイズの割合</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}>
              <td className="mono break-word">{r.label}</td>
              <td className="numeric mono">{r.objectCount.toLocaleString()}</td>
              <td className="numeric mono nowrap">{fmtSize(r.totalBytes)}</td>
              <td className="scan-col-meter">
                <span className="storage-meter" aria-hidden="true">
                  <span style={{ width: `${Math.max(1, (r.totalBytes / max) * 100)}%` }} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ScanModal({ connectionId, bucket, prefix, onClose, onResult }: Props) {
  const titleId = useId()
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [canceled, setCanceled] = useState(false)
  const [scanned, setScanned] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<'breakdown' | 'estimate'>('breakdown')
  const timer = useRef<number | null>(null)

  // 開いた直後に、実行中のジョブか保存済みの結果を引く。
  //
  // 走査は worker で走るのでリロードしても止まらないが、jobId は state なので
  // 失われる。実行中を引き当てて進捗へ戻れるようにする (これが無いと
  // 「走査中なのに『まだ走査していません』と出る」状態になる)。
  useEffect(() => {
    let cancelled = false
    api.latestScan(connectionId, bucket, prefix)
      .then(job => {
        if (cancelled || !job) return
        if (job.status === 'queued' || job.status === 'running') {
          // 実行中は result が null なので parse しない。
          setJobId(job.id)
          setRunning(true)
          if (job.progress && job.progress.kind === 'count') setScanned(job.progress.done)
          return
        }
        setResult(ScanResultSchema.parse(job.result))
        setScannedAt(job.finishedAt ?? null)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [connectionId, bucket, prefix])

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
    api.startScan(connectionId, bucket, prefix)
      .then(r => setJobId(r.jobId))
      .catch((e: Error) => { setError(e.message); setRunning(false) })
  }, [connectionId, bucket, prefix])

  const cancel = useCallback(() => {
    if (jobId !== null) api.cancelJob(jobId).catch(() => {})
  }, [jobId])

  // 走査の操作は内訳タブのときだけ下に出す (見積もりタブは自分の導線を持つ)。
  let footer = null
  if (tab === 'breakdown') {
    footer = running ? (
      <>
        <span className="scan-dialog-status">
          <span className="storage-pulse-dot" aria-hidden="true" />
          走査中…
        </span>
        <button type="button" className="button" onClick={cancel}>中止</button>
      </>
    ) : (
      <>
        {scannedAt && (
          <span className="scan-dialog-status">{fmtCacheAge(new Date(scannedAt))} に走査</span>
        )}
        {result ? (
          <button type="button" className="button" onClick={start}>
            <RefreshCw size={14} aria-hidden="true" />
            再走査
          </button>
        ) : (
          <button type="button" className="button primary" onClick={start}>走査する</button>
        )}
      </>
    )
  }

  return (
    <Dialog
      titleId={titleId}
      title="配下の集計"
      subtitle={`${bucket} / ${prefix || '(バケット直下)'}`}
      onClose={onClose}
      size="wide"
      footer={footer}
    >
      <div className="dialog-body">
        {/* 「配下に何が何 TB あるか」を見ている文脈は、そのまま「で、どこへ
            移すか」につながる。新しい導線を作らずこのダイアログを広げる
            (spec: 2026-08-22-transfer-estimate-design.md)。 */}
        <div className="tabs scan-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            id="scan-tab-breakdown"
            aria-selected={tab === 'breakdown'}
            aria-controls="scan-panel-breakdown"
            className="tab"
            onClick={() => setTab('breakdown')}
          >
            内訳
          </button>
          <button
            type="button"
            role="tab"
            id="scan-tab-estimate"
            aria-selected={tab === 'estimate'}
            aria-controls="scan-panel-estimate"
            className="tab"
            onClick={() => setTab('estimate')}
          >
            移送の見積もり
          </button>
        </div>

        {tab === 'estimate' ? (
          <div role="tabpanel" id="scan-panel-estimate" aria-labelledby="scan-tab-estimate">
            {/* タブを切り替えるたびにマウントし直す = 取り直す。走査を終えた
                直後に開いても古い結果が出ない。DB を読むだけなので軽い。 */}
            <EstimatePanel
              connectionId={connectionId}
              bucket={bucket}
              prefix={prefix}
              onNeedScan={() => setTab('breakdown')}
            />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="scan-panel-breakdown"
            aria-labelledby="scan-tab-breakdown"
            className="scan-panel"
          >
            {/* 走査中も結果も同じ枠。完了時にレイアウトが飛ばない。 */}
            {(running || result) && (
              <div className="scan-figures">
                {running ? (
                  <div className="scan-figure">
                    <span className="muted">走査済み</span>
                    <span className="scan-figure-value">
                      {scanned.toLocaleString()}<small>件</small>
                    </span>
                  </div>
                ) : result && (
                  <>
                    <div className="scan-figure">
                      <span className="muted">オブジェクト</span>
                      <span className="scan-figure-value">
                        {result.objectCount.toLocaleString()}<small>件</small>
                      </span>
                    </div>
                    <div className="scan-figure">
                      <span className="muted">合計サイズ</span>
                      <span className="scan-figure-value">{fmtSize(result.totalBytes)}</span>
                    </div>
                  </>
                )}
              </div>
            )}

            {running && (
              <div className="storage-busy-track">
                <div role="progressbar" aria-label="走査中" className="storage-busy-bar" />
              </div>
            )}

            {!running && result && (
              <>
                {result.partial && (
                  <p className="notice storage-warning">
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

            {canceled && <p className="muted">中止しました。</p>}
            {error && <p className="notice error">{error}</p>}
            {loaded && !result && !running && !error && (
              <p className="state-message">まだ走査していません。</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
