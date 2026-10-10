import { useState } from 'react'
import { ChevronDown, ChevronUp, PinOff } from 'lucide-react'
import { usePlayerDeck } from '../lib/playerDeck'
import { usePinnedPreviews } from '../lib/pinnedPreviews'
import { classify } from '../lib/api/mime'
import { PlayerDeck } from './PlayerDeck'
import { PinnedPreviewCard } from './PinnedPreviewCard'

// ドックの高さを <html> の --bottom-dock-height に書く。画面に貼り付くプレビューのドロワーが
// この分だけ低くなり、下端がドックの裏に隠れない。ドックが消えたら変数も消す。
function publishDockHeight(el: HTMLDivElement | null): (() => void) | undefined {
  if (!el) return undefined
  const root = document.documentElement
  const update = () => root.style.setProperty('--bottom-dock-height', `${el.offsetHeight}px`)
  update()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
  observer?.observe(el)
  return () => {
    observer?.disconnect()
    root.style.removeProperty('--bottom-dock-height')
  }
}

// 画面下部に fixed でドックされる共通コンテナ。上 = 同期プレイヤー (PlayerDeck)、
// 下 = ピン留めプレビューのグリッド。fixed 要素を 2 つ重ねると z-index と
// 下部余白の管理が破綻するため、単一の fixed コンテナに 2 セクションを同居させる。
// 各セクションは独立に折りたたみ可 (プレイヤーの既存トグルと同型)。
// デッキ 0 トラック & ピン 0 件なら何も出さない。
// 左端はサイドバーの右に揃える (preview.css の .bottom-dock が .app-shell の
// data-navigation を見て決める)。
export function BottomDock() {
  const { tracks } = usePlayerDeck()
  const { pins, clearPins } = usePinnedPreviews()
  const [pinsCollapsed, setPinsCollapsed] = useState(false)
  if (tracks.length === 0 && pins.length === 0) return null
  return (
    <div ref={publishDockHeight} className="bottom-dock touch-targets">
      {/* ドック全体は最大高さ付きで縦スクロール。ピンを積んでも本文を覆い尽くさない。 */}
      <div className="bottom-dock-scroll">
        <PlayerDeck />
        {pins.length > 0 && (
          <section className="dock-section">
            <div className="dock-section-header">
              <button
                type="button"
                className="dock-toggle"
                aria-expanded={!pinsCollapsed}
                onClick={() => setPinsCollapsed(c => !c)}
              >
                {pinsCollapsed
                  ? <ChevronUp size={16} aria-hidden="true" />
                  : <ChevronDown size={16} aria-hidden="true" />}
                <span>ピン留め ({pins.length})</span>
              </button>
              <button type="button" className="button small" onClick={clearPins}>
                <PinOff size={14} aria-hidden="true" />
                全部外す
              </button>
            </div>
            {!pinsCollapsed && (
              <div className="pinned-grid">
                {pins.map(item => (
                  <div
                    key={item.id}
                    className={
                      // tar アーカイブのカードはエントリ一覧テーブル + ページャを持ち、
                      // 狭いグリッドセルでは窮屈なので全幅にする。
                      item.entryPath == null && classify(item.key) === 'archive'
                        ? 'pinned-card-wide'
                        : undefined
                    }
                  >
                    <PinnedPreviewCard item={item} />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
