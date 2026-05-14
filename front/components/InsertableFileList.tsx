// README 編集ページの左ペイン専用の軽量ファイルリスト。
//
// 現在の prefix の直下のエントリ (recursive: false) だけを 1 度取得して表示する。
// StorageBrowser から pagination / preview drawer / search を剥がした派生形と思えばよい。
//
// 行クリック → onInsert を発火 (親が Monaco の現在カーソル位置に挿入)。
// ディレクトリ行末尾の「↓ 開く」 → 内部 state で prefix を切替えてそのサブディレクトリの
// 中身に進む。上部のパン屑で上位階層に戻れる。

import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import type { StorageList } from '../lib/api/types'

export interface InsertableEntry {
  /** 表示用のファイル/ディレクトリ basename (末尾スラッシュなし)。 */
  name: string
  /** ディレクトリなら true。 */
  isDir: boolean
  /** S3 上のフルキー (prefix を含む)。ディレクトリの場合は末尾に '/' あり。 */
  fullKey: string
}

interface Props {
  connId: string
  bucket: string
  /** 初期 prefix。内部 state でサブディレクトリへ潜れる。 */
  prefix: string
  onInsert: (entry: InsertableEntry) => void
}

type ListData = z.infer<typeof StorageList>

export function InsertableFileList({ connId, bucket, prefix: initialPrefix, onInsert }: Props) {
  const [prefix, setPrefix] = useState(initialPrefix)
  const [data, setData] = useState<ListData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    let cancelled = false
    api.list(connId, bucket, prefix, {}, { recursive: false })
      .then(r => { if (!cancelled) setData(r) })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [connId, bucket, prefix])

  // パン屑: bucket → セグメントへ。最後のセグメントは現在地なのでボタンにしない。
  // prefix = 'docs/sub/' なら crumbs = ['docs', 'sub']
  const crumbs = prefix.split('/').filter(Boolean)

  const goTo = (idx: number) => {
    // idx === -1 → bucket ルート (prefix = '')
    if (idx < 0) { setPrefix(''); return }
    const next = crumbs.slice(0, idx + 1).join('/') + '/'
    setPrefix(next)
  }

  return (
    <div className="filelist">
      <nav className="filelist__crumbs" aria-label="現在のディレクトリ">
        <button
          type="button"
          className="filelist__crumb"
          onClick={() => goTo(-1)}
          disabled={crumbs.length === 0}
          title="ルートへ"
        >
          {bucket}
        </button>
        {crumbs.map((seg, i) => (
          <span key={i} className="filelist__crumb-wrap">
            <span aria-hidden className="filelist__crumb-sep">/</span>
            <button
              type="button"
              className="filelist__crumb"
              onClick={() => goTo(i)}
              disabled={i === crumbs.length - 1}
            >
              {seg}
            </button>
          </span>
        ))}
      </nav>

      {error ? (
        <p className="filelist__error" role="alert">{error}</p>
      ) : !data ? (
        <p className="filelist__loading">読み込み中…</p>
      ) : data.directories.length === 0 && data.files.length === 0 ? (
        <p className="filelist__empty">エントリなし</p>
      ) : (
        <ul className="filelist__rows">
          {data.directories.map(d => {
            // d は prefix を含むフルパス。末尾 '/' を剥がして basename を取る。
            const base = d.slice(prefix.length).replace(/\/$/, '')
            return (
              <li key={d} className="filelist__row filelist__row--dir">
                <button
                  type="button"
                  className="filelist__name"
                  onClick={() => onInsert({ name: base, isDir: true, fullKey: d })}
                  title="クリックして本文に挿入"
                >
                  <span aria-hidden className="filelist__icon">📁</span>
                  {base}/
                </button>
                <button
                  type="button"
                  className="filelist__open"
                  onClick={() => setPrefix(d)}
                  title="このディレクトリへ潜る"
                  aria-label={`${base} を開く`}
                >
                  ↓ 開く
                </button>
              </li>
            )
          })}
          {data.files.map(f => {
            const base = f.key.slice(prefix.length)
            return (
              <li key={f.key} className="filelist__row filelist__row--file">
                <button
                  type="button"
                  className="filelist__name"
                  onClick={() => onInsert({ name: base, isDir: false, fullKey: f.key })}
                  title="クリックして本文に挿入"
                >
                  <span aria-hidden className="filelist__icon">📄</span>
                  {base}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {data && (data.nextContinuation || data.nextStartAfter) && (
        <p className="filelist__hint">
          続きあり — エントリが多いです。末端まで潜ってから挿入することをお勧めします。
        </p>
      )}
    </div>
  )
}
