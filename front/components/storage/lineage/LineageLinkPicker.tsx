// 家系図の「リンクを追加」フローで、相手ノード (bucket / directory / file) を
// 選ぶモーダルピッカー。InsertableFileList (README エディタの左ペイン) と
// 同じ「非 recursive リスト + 内部 state での潜り」の作りだが、バケットを
// またいで選べる点と、「今見ている階層そのもの」を選べる点が異なる。

import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { api } from '../../../lib/api/client'
import { StorageList } from '../../../lib/api/types'
import { sameNode, type LineageNode } from '../../../lib/lineageGraph'

interface Props {
  connId: string
  initialBucket: string
  initialPrefix: string
  exclude: LineageNode
  onSelect: (node: LineageNode) => void
  onCancel: () => void
}

type ListResp = z.infer<typeof StorageList>

export function LineageLinkPicker(
  { connId, initialBucket, initialPrefix, exclude, onSelect, onCancel }: Props,
) {
  const [buckets, setBuckets] = useState<string[] | null>(null)
  const [bucket, setBucket] = useState(initialBucket)
  const [prefix, setPrefix] = useState(initialPrefix)
  const [data, setData] = useState<ListResp | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.buckets(connId).then(r => setBuckets(r.buckets.map(b => b.name))).catch(() => setBuckets([]))
  }, [connId])

  useEffect(() => {
    setData(null)
    setError(null)
    let cancelled = false
    api.list(connId, bucket, prefix, {}, { recursive: false })
      .then(r => { if (!cancelled) setData(r) })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [connId, bucket, prefix])

  const crumbs = prefix.split('/').filter(Boolean)
  const goTo = (idx: number) => {
    if (idx < 0) { setPrefix(''); return }
    setPrefix(crumbs.slice(0, idx + 1).join('/') + '/')
  }
  const changeBucket = (next: string) => { setBucket(next); setPrefix('') }

  const currentIsExcluded = sameNode({ bucket, path: prefix }, exclude)

  return (
    <div className="modal-backdrop modal-backdrop--lineage-picker" role="presentation">
      <button
        type="button"
        className="modal-backdrop__close-overlay"
        onClick={onCancel}
        aria-label="モーダルを閉じる"
        tabIndex={-1}
      />
      <div className="modal modal--lineage-picker" role="dialog" aria-modal="true" aria-labelledby="lineage-picker-title">
        <header className="lineage-picker__head">
          <h3 id="lineage-picker-title" className="lineage-picker__title">ノードを選択</h3>
          <label className="lineage-picker__bucket-select">
            <span className="label">バケット</span>
            <select value={bucket} onChange={e => changeBucket(e.target.value)} disabled={!buckets}>
              {(buckets ?? [bucket]).map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        </header>

        <div className="filelist">
          <nav className="filelist__crumbs" aria-label="現在のディレクトリ">
            <button type="button" className="filelist__crumb" onClick={() => goTo(-1)} disabled={crumbs.length === 0}>
              {bucket}
            </button>
            {crumbs.map((seg, i) => (
              <span key={i} className="filelist__crumb-wrap">
                <span aria-hidden className="filelist__crumb-sep">/</span>
                <button type="button" className="filelist__crumb" onClick={() => goTo(i)} disabled={i === crumbs.length - 1}>
                  {seg}
                </button>
              </span>
            ))}
          </nav>

          <button
            type="button"
            className="filelist__select-current"
            disabled={currentIsExcluded}
            onClick={() => onSelect({ bucket, path: prefix })}
          >
            {prefix === '' ? 'このバケット直下を選択' : 'このディレクトリを選択'}
          </button>

          {error ? (
            <p className="filelist__error" role="alert">{error}</p>
          ) : !data ? (
            <p className="filelist__loading">読み込み中…</p>
          ) : data.directories.length === 0 && data.files.length === 0 ? (
            <p className="filelist__empty">エントリなし</p>
          ) : (
            <ul className="filelist__rows">
              {data.directories.map(d => {
                const base = d.slice(prefix.length).replace(/\/$/, '')
                const excluded = sameNode({ bucket, path: d }, exclude)
                return (
                  <li key={d} className="filelist__row filelist__row--dir">
                    <span className="filelist__label">
                      <span aria-hidden className="filelist__icon">📁</span>
                      {base}/
                    </span>
                    <button type="button" className="filelist__select" disabled={excluded} onClick={() => onSelect({ bucket, path: d })}>
                      選択
                    </button>
                    <button type="button" className="filelist__open" onClick={() => setPrefix(d)}>
                      ↓ 開く
                    </button>
                  </li>
                )
              })}
              {data.files.map(f => {
                const base = f.key.slice(prefix.length)
                const excluded = sameNode({ bucket, path: f.key }, exclude)
                return (
                  <li key={f.key} className="filelist__row filelist__row--file">
                    <span className="filelist__label">
                      <span aria-hidden className="filelist__icon">📄</span>
                      {base}
                    </span>
                    <button type="button" className="filelist__select" disabled={excluded} onClick={() => onSelect({ bucket, path: f.key })}>
                      選択
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>キャンセル</button>
        </div>
      </div>
    </div>
  )
}
