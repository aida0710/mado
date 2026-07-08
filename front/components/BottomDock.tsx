import { useState } from 'react'
import { usePlayerDeck } from '../lib/playerDeck'
import { usePinnedPreviews } from '../lib/pinnedPreviews'
import { classify } from '../lib/api/mime'
import { PlayerDeck } from './PlayerDeck'
import { PinnedPreviewCard } from './PinnedPreviewCard'

// 画面下部に fixed でドックされる共通コンテナ。上 = 同期プレイヤー (PlayerDeck)、
// 下 = ピン留めプレビューのグリッド。fixed 要素を 2 つ重ねると z-index と
// 下部余白の管理が破綻するため、単一の fixed コンテナに 2 セクションを同居させる。
// 各セクションは独立に折りたたみ可 (プレイヤーの既存トグルと同型)。
// デッキ 0 トラック & ピン 0 件なら何も出さない。
export function BottomDock() {
  const { tracks } = usePlayerDeck()
  const { pins, clearPins } = usePinnedPreviews()
  const [pinsCollapsed, setPinsCollapsed] = useState(false)
  if (tracks.length === 0 && pins.length === 0) return null
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t"
      style={{ borderColor: 'var(--color-rule-strong)', background: 'var(--paper)' }}
    >
      {/* ドック全体は最大高さ付きで縦スクロール。ピンを積んでも本文を覆い尽くさない。 */}
      <div className="mx-auto max-h-[60vh] max-w-[1180px] overflow-y-auto px-4 py-2 sm:px-6">
        <PlayerDeck />
        {pins.length > 0 && (
          <section
            className={tracks.length > 0 ? 'mt-1 pt-1' : undefined}
            style={tracks.length > 0 ? { borderTop: '1px solid var(--rule)' } : undefined}
          >
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="ghost text-[11px]"
                onClick={() => setPinsCollapsed(c => !c)}
              >
                {pinsCollapsed ? '▲' : '▼'} ピン留め ({pins.length})
              </button>
              <div className="flex-1" />
              <button type="button" className="ghost text-[11px]" onClick={clearPins}>
                全部外す
              </button>
            </div>
            {!pinsCollapsed && (
              <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 xl:grid-cols-3">
                {pins.map(item => (
                  <div
                    key={item.id}
                    className={
                      // tar アーカイブのカードはエントリ一覧テーブル + ページャを持ち、
                      // 狭いグリッドセルでは窮屈なので全幅にする。
                      item.entryPath == null && classify(item.key) === 'archive'
                        ? 'sm:col-span-full'
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
