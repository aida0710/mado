import { createContext, useContext } from 'react'

export interface AuthUser {
  id: string
  username: string | null
  email: string | null
  displayName: string
  roles: string[]
  permissions: string[]
  mustChangePassword: boolean
}

export interface AuthContextValue {
  enabled: boolean
  user: AuthUser | null
  logout(): Promise<void>
  reload(): Promise<void>
}

export const AuthContext = createContext<AuthContextValue>({
  enabled: false,
  user: null,
  logout: async () => {},
  reload: async () => {},
})

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
