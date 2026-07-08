import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export interface DeckTrack {
  id: string
  label: string
  connId: string
  bucket: string
  key: string
  entryPath?: string
}

interface PlayerDeckApi {
  tracks: DeckTrack[]
  addTrack(t: Omit<DeckTrack, 'id'>): void
  removeTrack(id: string): void
  clear(): void
}

const Ctx = createContext<PlayerDeckApi | null>(null)

// ルーティングの外側 (App) に置く。Storage 内のページ遷移でもデッキは消えない。
// リロードでは消える (v1 では永続化しない)。
export function PlayerDeckProvider({ children }: { children: ReactNode }) {
  const [tracks, setTracks] = useState<DeckTrack[]>([])
  const addTrack = useCallback((t: Omit<DeckTrack, 'id'>) => {
    const id = [t.connId, t.bucket, t.key, t.entryPath ?? ''].join('|')
    setTracks(cur => (cur.some(x => x.id === id) ? cur : [...cur, { ...t, id }]))
  }, [])
  const removeTrack = useCallback((id: string) => {
    setTracks(cur => cur.filter(t => t.id !== id))
  }, [])
  const clear = useCallback(() => setTracks([]), [])
  const api = useMemo(() => ({ tracks, addTrack, removeTrack, clear }), [tracks, addTrack, removeTrack, clear])
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

// Provider 外で使われたときのフォールバック。throw すると Provider を知らない
// 文脈 (単体テストや Storybook 的な部分レンダー) で EntryTable 等が丸ごと落ちる
// ため、「何もしないデッキ」に劣化させる。モジュール定数なので参照は安定し、
// useMemo の依存に入れても再計算を起こさない。
const NOOP_DECK: PlayerDeckApi = {
  tracks: [],
  addTrack: () => {},
  removeTrack: () => {},
  clear: () => {},
}

// Context + hook を同一ファイルに同居させているため react-refresh/only-export-components が
// usePlayerDeck (非コンポーネントの named export) を検出する。ファイル分割すると
// 「playerDeck.tsx から PlayerDeckProvider と usePlayerDeck の両方をエクスポートする」
// という要件(テストの import 元も単一)と衝突するため、この 1 行のみ抑制する。
// eslint-disable-next-line react-refresh/only-export-components
export function usePlayerDeck(): PlayerDeckApi {
  return useContext(Ctx) ?? NOOP_DECK
}
