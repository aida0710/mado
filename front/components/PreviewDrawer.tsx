import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../lib/api/client'
import { classify } from '../lib/api/mime'
import { PreviewText } from './PreviewText'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewArchive } from './PreviewArchive'

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
  if (!k) return null
  const kind = classify(k)
  const filename = k.split('/').pop() ?? 'file'
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
      <div className="drawer__body">
        {/* ファイル切替で内部 state (本文/コピー表示) をリセットするため key で再マウント。 */}
        {kind === 'text' && (
          <PreviewText key={`${connId}|${bucket}|${k}`} connId={connId} bucket={bucket} k={k} />
        )}
        {kind === 'image' && <PreviewImage connId={connId} bucket={bucket} k={k} />}
        {kind === 'audio' && <PreviewAudio connId={connId} bucket={bucket} k={k} />}
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
    </aside>
  )
}
