import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { FeatureFlags } from '../api/types'

interface FlagsContextValue {
  flags: FeatureFlags | null   // null while loading
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

/** Treats unknown flags and unloaded state as enabled (fail-open).
 *  Returns false only when the flag is explicitly false. */
export function isEnabled(flags: FeatureFlags | null, name: string): boolean {
  if (!flags) return true
  return flags[name] !== false
}
