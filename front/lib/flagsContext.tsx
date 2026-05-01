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
 *  フラグが明示的に false の場合のみ false を返す。 */
export function isEnabled(flags: FeatureFlags | null, name: string): boolean {
  if (!flags) return true
  return flags[name] !== false
}
