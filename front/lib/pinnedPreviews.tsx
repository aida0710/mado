import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export interface PinnedItem {
  id: string          // connId|bucket|key|entryPath?? '' (重複ピンは無視)
  connId: string
  bucket: string
  key: string         // tar 内エントリの場合は tar のキー
  entryPath?: string  // tar 内エントリのパス
}

interface PinnedPreviewsApi {
  pins: PinnedItem[]
  addPin(item: Omit<PinnedItem, 'id'>): void
  removePin(id: string): void
  clearPins(): void
}

const Ctx = createContext<PinnedPreviewsApi | null>(null)

// playerDeck.tsx と同型。ルーティングの外 (App、PlayerDeckProvider の隣) に置く。
// ディレクトリ移動を跨いで残り、リロードで消える (v1 では永続化しない)。
export function PinnedPreviewsProvider({ children }: { children: ReactNode }) {
  const [pins, setPins] = useState<PinnedItem[]>([])
  const addPin = useCallback((item: Omit<PinnedItem, 'id'>) => {
    const id = [item.connId, item.bucket, item.key, item.entryPath ?? ''].join('|')
    setPins(cur => (cur.some(p => p.id === id) ? cur : [...cur, { ...item, id }]))
  }, [])
  const removePin = useCallback((id: string) => {
    setPins(cur => cur.filter(p => p.id !== id))
  }, [])
  const clearPins = useCallback(() => setPins([]), [])
  const api = useMemo(
    () => ({ pins, addPin, removePin, clearPins }),
    [pins, addPin, removePin, clearPins],
  )
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

// Provider 外で使われたときのフォールバック (usePlayerDeck と同じ理由・同じ形)。
const NOOP_PINS: PinnedPreviewsApi = {
  pins: [],
  addPin: () => {},
  removePin: () => {},
  clearPins: () => {},
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePinnedPreviews(): PinnedPreviewsApi {
  return useContext(Ctx) ?? NOOP_PINS
}
