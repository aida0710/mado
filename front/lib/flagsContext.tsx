import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api/client'
import type { FeatureFlags } from './api/types'

interface FlagsContextValue {
  flags: FeatureFlags | null   // ローディング中は null
  refresh: () => void
}

const FlagsContext = createContext<FlagsContextValue>({
  flags: null,
  refresh: () => {},
})

export function FlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<FeatureFlags | null>(null)

  const refresh = useCallback(() => {
    api.flags()
      .then(setFlags)
      .catch(() => setFlags({}))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return (
    <FlagsContext.Provider value={{ flags, refresh }}>
      {children}
    </FlagsContext.Provider>
  )
}

export function useFlags(): FlagsContextValue {
  return useContext(FlagsContext)
}

/** 未知フラグおよびロード前の状態は有効として扱う (フェイルオープン)。
 *  フラグが明示的に false の場合のみ false を返す。
 *  metrics タブのような UX 制御で「ロード中のチラつきを避ける」目的で意図的に
 *  この設計にしている。セキュリティ目的で UI を隠したい場合は isEnabledStrict を使う。 */
export function isEnabled(flags: FeatureFlags | null, name: string): boolean {
  if (!flags) return true
  return flags[name] !== false
}

/** ロード前 (null) ・未定義フラグ・false すべて「無効」として扱う (フェイルクローズ)。
 *  将来のセキュリティ系フラグ (例: 管理者専用 UI を隠す) で使う想定。 */
export function isEnabledStrict(flags: FeatureFlags | null, name: string): boolean {
  return flags?.[name] === true
}
