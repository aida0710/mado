import { createContext, use } from 'react'
import type { Connection } from './api/types'

export const ConnectionContext = createContext<Connection | null>(null)

export function useConnection(): Connection {
  const c = use(ConnectionContext)
  if (!c) throw new Error('useConnection must be used inside <ConnectionContext.Provider>')
  return c
}
