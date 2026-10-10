import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { Download, Pin, RotateCcw, X } from 'lucide-react'
import { api } from '../lib/api/client'
import { classify } from '../lib/api/mime'
import { usePinnedPreviews } from '../lib/pinnedPreviews'
import { useCapabilities } from '../lib/useCapabilities'
import { PreviewText } from './PreviewText'
import { PreviewImage } from './PreviewImage'
import { PreviewAudio } from './PreviewAudio'
import { PreviewVideo } from './PreviewVideo'
import { PreviewArchive } from './PreviewArchive'

interface Props {
  connectionId: string
  bucket: string
  k: string | null
  onClose: () => void
  // 幅リサイズ用ハンドルのイベント (useDrawerResize から)。drawer の左端に置き、
  // drawer の高さに収まるようここ (drawer 内) で描画する。省略時はハンドル無し。
  onResizeStart?: (e: ReactPointerEvent) => void
  onResizeKeyDown?: (e: ReactKeyboardEvent) => void
  // 幅を既定 (画面追従) に戻す。widthCustomized=true (= ユーザが幅変更済) の時だけ
  // ヘッダにリセットボタンを出す。一覧と並ばない 900px 未満は CSS で隠す。
  onResetWidth?: () => void
  widthCustomized?: boolean
  // tar アーカイブを開いているときに、その中のどのエントリを開くか (URL の ?entry=)。
  // アーカイブ以外の種別では意味を持たないので単に無視される。
  entry?: string | null
  onEntryChange?: (entryPath: string | null) => void
}

/**
 * 一覧の右に出すプレビュー。上の帯にファイルのパスと操作 (幅を戻す・ピン留め・
 * ダウンロード・閉じる)、その下に種別ごとのプレビューを置く。
 */
export function PreviewDrawer({
  connectionId, bucket, k, onClose,
  onResizeStart, onResizeKeyDown, onResetWidth, widthCustomized,
  entry, onEntryChange,
}: Props) {
  const { pins, addPin } = usePinnedPreviews()
  const caps = useCapabilities(connectionId)
  if (!k) return null
  const kind = classify(k)
  const filename = k.split('/').pop() ?? 'file'
  // ドロワーのピン留めは「今開いている k」だけを対象にする (tar 内エントリは扱わない
  // — それは TarEntryModal 側のピン留めが担当する) ので entryPath なしで比較する。
  const alreadyPinned = pins.some(
    p => p.connectionId === connectionId && p.bucket === bucket && p.key === k && p.entryPath === undefined,
  )
  const pinLabel = alreadyPinned ? 'ピン留め済み' : 'ピン留め'
  return (
    <aside className="drawer">
      {onResizeStart && (
        <div
          className="drawer-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="プレビュー幅を変更 (左右キーで調整)"
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKeyDown}
        />
      )}
      <header className="drawer-header">
        <p className="drawer-path mono">{k}</p>
        <div className="drawer-actions">
          {onResetWidth && widthCustomized && (
            <button
              type="button"
              className="icon-button drawer-reset"
              onClick={onResetWidth}
              aria-label="プレビュー幅を既定に戻す"
              title="プレビュー幅を既定に戻す"
            >
              <RotateCcw size={16} aria-hidden="true" />
            </button>
          )}
          {/* tar アーカイブ自体はピン留め対象外 (個々のエントリのみピン留め可能)。 */}
          {kind !== 'archive' && (
            <button
              type="button"
              className="icon-button"
              onClick={() => addPin({ connectionId, bucket, key: k })}
              disabled={alreadyPinned}
              data-pinned={alreadyPinned ? 'true' : undefined}
              aria-label={pinLabel}
              title={pinLabel}
            >
              <Pin size={16} fill={alreadyPinned ? 'currentColor' : 'none'} aria-hidden="true" />
            </button>
          )}
          {caps.download && (
            <a
              className="icon-button"
              href={api.downloadUrl(connectionId, bucket, k)}
              download={filename}
              aria-label={`${filename} をダウンロード`}
              title="ダウンロード"
            >
              <Download size={16} aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close preview"
            title="閉じる"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="drawer-body">
        {/* ファイル切替でコピー完了の表示をリセットするため key で再マウントする。
            本文の切り替えは useSniffedText が url をキーに持つので key に依存しない。 */}
        {/* 画像 / 音声 / アーカイブ以外はすべてテキストとして開こうとする。
            中身がバイナリなら PreviewText 側が「プレビュー非対応」を出す。 */}
        {/* 権限で閉じられている種別は理由を出す。無言で空になると
            「壊れている」と誤解されるため。 */}
        {((kind === 'archive' && !caps.archive) || (kind !== 'archive' && !caps.preview)) && (
          <p className="muted">
            この接続では{kind === 'archive' ? '圧縮ファイルを開くこと' : 'ファイルのプレビュー'}が
            無効になっています (Settings → 接続で変更できます)。
          </p>
        )}
        {kind === 'unknown' && caps.preview && (
          <PreviewText key={`${connectionId}|${bucket}|${k}`} connectionId={connectionId} bucket={bucket} k={k} />
        )}
        {kind === 'image' && caps.preview && <PreviewImage connectionId={connectionId} bucket={bucket} k={k} />}
        {kind === 'audio' && caps.preview && (
          <PreviewAudio key={`${connectionId}|${bucket}|${k}`} connectionId={connectionId} bucket={bucket} k={k} />
        )}
        {kind === 'video' && caps.preview && (
          <PreviewVideo key={`${connectionId}|${bucket}|${k}`} connectionId={connectionId} bucket={bucket} k={k} />
        )}
        {kind === 'archive' && caps.archive && (
          <PreviewArchive
            // ファイル切替時に内部 state (offset / pageSize) を一括リセットする。
            key={`${connectionId}|${bucket}|${k}`}
            connectionId={connectionId}
            bucket={bucket}
            k={k}
            // URL (?entry=) と繋ぐのはこの経路だけ。ピンカードから描画される
            // PreviewArchive には渡さない (PreviewArchive 側のコメント参照)。
            initialEntry={entry ?? null}
            onEntryChange={onEntryChange}
          />
        )}
      </div>
    </aside>
  )
}
