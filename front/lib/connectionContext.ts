import { createContext, useContext } from 'react'
import type { Connection } from '../api/types'

export const ConnectionContext = createContext<Connection | null>(null)

export function useConnection(): Connection {
  const c = useContext(ConnectionContext)
  if (!c) throw new Error('useConnection must be used inside <ConnectionContext.Provider>')
  return c
}
