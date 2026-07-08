import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../lib/api/client'
import { classify } from '../lib/api/mime'
import { usePinnedPreviews } from '../lib/pinnedPreviews'
import { PreviewText } from './PreviewText'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewArchive } from './PreviewArchive'
import { PinnedPreviewCard } from './PinnedPreviewCard'

interface Props {
  connId: string
  bucket: string
  k: string | null
  onClose: () => void
  // 幅リサイズ用ハンドルのイベント (useDrawerResize から)。drawer の左端に置き、
  // drawer の高さに収まるようここ (drawer 内) で描画する。省略時はハンドル無し。
  onResizeStart?: (e: ReactPointerEvent) => void
  onResizeKeyDown?: (e: ReactKeyboardEvent) => void
  // 幅を既定 (画面追従) に戻す。widthCustomized=true (= ユーザが幅変更済) の時だけ
  // ヘッダにリセットボタンを出す。CSS 側で <1024px は非表示。
  onResetWidth?: () => void
  widthCustomized?: boolean
}

export function PreviewDrawer({
  connId, bucket, k, onClose,
  onResizeStart, onResizeKeyDown, onResetWidth, widthCustomized,
}: Props) {
  const { pins, addPin, clearPins } = usePinnedPreviews()
  // 現在プレビュー (k) が無くても、ピンが残っていればドロワー自体は表示し続ける。
  // 従来は `k` の有無だけで判定していたが、ピンは行クリック/現在プレビューの
  // クローズを跨いで生き残るので条件を拡張する。
  if (!k && pins.length === 0) return null
  const kind = k ? classify(k) : null
  const filename = k ? (k.split('/').pop() ?? 'file') : ''
  // ドロワーの 📌 は「今開いている k」だけを対象にする (tar 内エントリは扱わない
  // — それは TarEntryModal 側の 📌 が担当する) ので entryPath なしで比較する。
  const alreadyPinned = k != null && pins.some(
    p => p.connId === connId && p.bucket === bucket && p.key === k && p.entryPath === undefined,
  )
  return (
    <aside className="drawer">
      {onResizeStart && (
        <div
          className="drawer__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="プレビュー幅を変更 (左右キーで調整)"
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKeyDown}
        />
      )}
      {k && (
        <header className="drawer__head">
          <p className="drawer__title">{k}</p>
          {onResetWidth && widthCustomized && (
            <button
              type="button"
              className="ghost drawer__reset"
              onClick={onResetWidth}
              aria-label="プレビュー幅を既定に戻す"
              title="プレビュー幅を既定に戻す"
            >
              <span aria-hidden>↔</span>
            </button>
          )}
          <button
            type="button"
            className="ghost"
            onClick={() => addPin({ connId, bucket, key: k })}
            disabled={alreadyPinned}
            aria-label={alreadyPinned ? 'ピン留め済み' : 'ピン留め'}
            title={alreadyPinned ? 'ピン留め済み' : 'ピン留め'}
          >
            <span aria-hidden>📌</span>
          </button>
          <a
            className="ghost no-underline"
            href={api.downloadUrl(connId, bucket, k)}
            download={filename}
            aria-label={`${filename} をダウンロード`}
            title="ダウンロード"
          >
            <span aria-hidden>↓</span>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em]">DL</span>
          </a>
          <button
            className="ghost"
            onClick={onClose}
            aria-label="Close preview"
            title="閉じる"
          >
            <span aria-hidden>✕</span>
          </button>
        </header>
      )}
      <div className="drawer__body">
        {k && (
          <div>
            {/* ファイル切替で内部 state (本文/コピー表示) をリセットするため key で再マウント。 */}
            {kind === 'text' && (
              <PreviewText key={`${connId}|${bucket}|${k}`} connId={connId} bucket={bucket} k={k} />
            )}
            {kind === 'image' && <PreviewImage connId={connId} bucket={bucket} k={k} />}
            {kind === 'audio' && (
              <PreviewAudio key={`${connId}|${bucket}|${k}`} connId={connId} bucket={bucket} k={k} />
            )}
            {kind === 'archive' && (
              <PreviewArchive
                // ファイル切替時に内部 state (offset / pageSize) を一括リセットする。
                key={`${connId}|${bucket}|${k}`}
                connId={connId}
                bucket={bucket}
                k={k}
              />
            )}
            {kind === 'unknown' && (
              <p className="text-[13px] text-ink-7">
                プレビュー非対応のファイル種別です。上の DL ボタンからダウンロードできます。
              </p>
            )}
          </div>
        )}
        {pins.length > 0 && (
          <section className={k ? 'mt-5 pt-4' : ''} style={k ? { borderTop: '1px solid var(--rule)' } : undefined}>
            <header className="flex items-center justify-between gap-2 pb-3">
              <p className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
                ピン留め ({pins.length})
              </p>
              <button type="button" className="ghost text-[11px]" onClick={clearPins}>
                全部外す
              </button>
            </header>
            <div className="flex flex-col gap-3">
              {pins.map(item => <PinnedPreviewCard key={item.id} item={item} />)}
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}
