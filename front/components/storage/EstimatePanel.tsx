// 転送先ごとの費用・所要時間の比較
// (spec: 2026-08-22-transfer-estimate-design.md)。
//
// 走査済みディレクトリを、登録済みの各接続へ移したらどうなるかを並べる。
// 数字の出所は走査結果 (件数・合計サイズ) と接続の設定だけで、S3 は叩かない。
//
// 設計上の要点が 2 つある:
//
// - **所要時間はレンジで出す。** 単一の数字は外れたときに機能全体の信用を落とす。
// - **移動元から出す費用 (egress) を畳んだ行にも出す。** 移動先の月額だけを見て
//   決めると桁を間違える。AWS から 40TB 出すと、置き続けるより高くつくことがある。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api/client'
import { PROVIDER_LABELS, type TransferCandidate, type TransferEstimate } from '../../lib/api/types'
import { fmtCacheAge, fmtDurationRange, fmtSize, fmtUsd } from '../../lib/format'

interface Props {
  connId: string
  bucket: string
  prefix: string
  /** 未走査だったときに内訳タブ (走査ボタンのある側) へ戻す。 */
  onNeedScan: () => void
}

/** 単価の更新ジョブを待つポーリング間隔と上限 (= 最長 60 秒待つ)。 */
const REFRESH_POLL_MS = 1000
const REFRESH_POLL_LIMIT = 60

type State =
  | { kind: 'loading' }
  | { kind: 'unscanned' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; data: TransferEstimate }

/** 内訳の 1 行。0 の項目も出す — 「かからない」ことが分かるのが大事。 */
function CostRow({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="est-brk__row">
      <span className="est-brk__k">{label}</span>
      <span className="est-brk__v">{fmtUsd(value)}</span>
      {note && <small className="est-brk__note">{note}</small>}
    </div>
  )
}

function CandidateRow({ c, expanded, onToggle }: {
  c: TransferCandidate
  expanded: boolean
  onToggle: () => void
}) {
  const label = c.storageClassLabel && c.provider === 'aws'
    ? `${c.name} · ${c.storageClassLabel}`
    : c.name

  return (
    <>
      <button
        type="button"
        className={`est-row${expanded ? ' est-row--open' : ''}`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="est-row__nm">
          <span className="est-row__caret" aria-hidden>{expanded ? '▾' : '▸'}</span>
          {label}
          {c.sameConnection && <span className="est-row__here">現在地</span>}
        </span>
        <span className="est-row__dur">
          {fmtDurationRange(c.durationSec.optimistic, c.durationSec.pessimistic)}
        </span>
        <span className="est-row__up">{fmtUsd(c.upfront.total)}</span>
        <span className="est-row__mo">{fmtUsd(c.monthlyUsd)}</span>
        {/* 警告が無くても列を残す。省くと grid が詰まって右 3 列がずれる。 */}
        <span
          className="est-row__warn"
          aria-label={c.warnings.length > 0 ? `注意 ${c.warnings.length} 件` : undefined}
        >
          {c.warnings.length > 0 ? `⚠ ${c.warnings.length}` : ''}
        </span>
      </button>

      {expanded && (
        <div className="est-brk">
          <div className="est-brk__grid">
            <CostRow
              label="移動元から出す (egress)"
              value={c.upfront.egress}
              note={c.sameConnection ? '同じ接続内なので回線を通らない' : undefined}
            />
            <CostRow label="取り出し" value={c.upfront.retrieval} />
            <CostRow label="GET リクエスト" value={c.upfront.getRequests} />
            <CostRow
              label="PUT リクエスト"
              value={c.upfront.putRequests}
              note={`${c.putRequestCount.toLocaleString()} 回`}
            />
            <CostRow
              label="月額"
              value={c.monthlyUsd}
              note={`課金対象 ${fmtSize(c.billableBytes)}`}
            />
          </div>

          {c.warnings.length > 0 && (
            <ul className="est-warns">
              {c.warnings.map(w => (
                <li key={w.kind} className="est-warns__item">{w.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

export function EstimatePanel({ connId, bucket, prefix, onNeedScan }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [openId, setOpenId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  /** 単価を更新したあと見積もりを取り直すためのトリガ。 */
  const [reloadKey, setReloadKey] = useState(0)

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    let cancelled = false
    // ここで setState({ kind: 'loading' }) はしない。effect 本体での同期
    // setState は cascading render になる (react-hooks/set-state-in-effect)。
    // 初期値が loading であり、このパネルはタブを開くたびにマウントし直される
    // ので、props が変わって前の結果が残ることは無い。
    api.estimate(connId, bucket, prefix)
      .then(r => {
        if (cancelled) return
        setState(r ? { kind: 'data', data: r } : { kind: 'unscanned' })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ kind: 'error', message: e.message })
      })
    return () => { cancelled = true }
  }, [connId, bucket, prefix, reloadKey])

  // 単価の取得はジョブで走る (外部 HTTP がハングしてもこの画面を巻き込まない)。
  // 完了を待ってから見積もりを取り直す — 新しい単価で数字が変わるのを見せたいため。
  const refreshPricing = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const { jobId } = await api.refreshPricing()
      for (let i = 0; i < REFRESH_POLL_LIMIT; i += 1) {
        await new Promise(r => setTimeout(r, REFRESH_POLL_MS))
        if (!alive.current) return
        const job = await api.getJob(jobId)
        if (job.status === 'done') {
          setReloadKey(k => k + 1)
          return
        }
        if (job.status === 'error') {
          // 外に出られない環境ではここに来る。同梱の単価で見積もりは続く。
          setRefreshError(job.error ?? '単価を取得できませんでした')
          return
        }
        if (job.status === 'canceled') return
      }
      setRefreshError('更新に時間がかかっています。あとで開き直してください')
    } catch (e) {
      setRefreshError((e as Error).message)
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [])

  const toggle = useCallback((id: string) => {
    setOpenId(cur => (cur === id ? null : id))
  }, [])

  // 現在地を先頭に、あとは月額の安い順。同額なら初期費用で並べる。
  const rows = useMemo(() => {
    if (state.kind !== 'data') return []
    return [...state.data.candidates].sort((a, b) => {
      if (a.sameConnection !== b.sameConnection) return a.sameConnection ? -1 : 1
      if (a.monthlyUsd !== b.monthlyUsd) return a.monthlyUsd - b.monthlyUsd
      return a.upfront.total - b.upfront.total
    })
  }, [state])

  if (state.kind === 'loading') {
    return <p className="scan-modal__note">見積もり中…</p>
  }

  if (state.kind === 'unscanned') {
    return (
      <p className="scan-modal__note">
        見積もりには配下の集計が要ります。
        <button type="button" className="ghost" onClick={onNeedScan}>走査する</button>
      </p>
    )
  }

  if (state.kind === 'error') {
    return <p className="error">{state.message}</p>
  }

  const { source, scan, catalog } = state.data
  const avg = scan.objectCount > 0 ? scan.totalBytes / scan.objectCount : 0

  return (
    <div className="est">
      <div className="est-head">
        <span>
          <strong>{scan.objectCount.toLocaleString()}</strong> 件 /{' '}
          <strong>{fmtSize(scan.totalBytes)}</strong>
          <small>（平均 {fmtSize(avg)}）</small>
        </span>
        <small className="est-head__src">
          移動元 {source.name}
          {source.provider !== 'aws' && `（${PROVIDER_LABELS[source.provider]}）`}
        </small>
      </div>

      <div className="est-table">
        <div className="est-table__head">
          <span className="est-row__nm">移動先</span>
          <span className="est-row__dur">所要</span>
          <span className="est-row__up">初期</span>
          <span className="est-row__mo">月額</span>
          <span className="est-row__warn" />
        </div>
        {rows.map(c => (
          <CandidateRow
            key={c.connId}
            c={c}
            expanded={openId === c.connId}
            onToggle={() => toggle(c.connId)}
          />
        ))}
      </div>

      <p className="est-foot">
        {catalog.source === 'fetched' && catalog.fetchedAt
          ? `単価は ${fmtCacheAge(new Date(catalog.fetchedAt))} に取得`
          // 「取得できていない」と「無料」を取り違えさせない。
          : `単価は同梱の ${catalog.asOf} 版（まだ取得していません）`}
        {' '}
        <button type="button" className="ghost" onClick={refreshPricing} disabled={refreshing}>
          {refreshing ? '更新中…' : '単価を更新'}
        </button>
        {catalog.stale && !refreshing && !refreshError && (
          <strong className="est-foot__stale">{' '}単価が古くなっています。</strong>
        )}
        {refreshError && <span className="error">{' '}{refreshError}</span>}
      </p>
      <p className="est-foot">
        所要時間は接続ごとの帯域設定から出しています。
        実測を入れると精度が上がります（Settings → 接続）。
      </p>
    </div>
  )
}
