export type UserStatus = 'active' | 'disabled'

export interface AuthUser {
  id: string
  username: string | null
  email: string | null
  displayName: string
  status: UserStatus
  roles: string[]
  permissions: string[]
  mustChangePassword: boolean
}

export interface SessionPrincipal {
  kind: 'user'
  sessionId: string
  user: AuthUser
}

export interface ServicePrincipal {
  kind: 'service_account'
  serviceAccountId: string
  serviceAccountName: string
  keyId: string
  scopes: string[]
  namespaces: string[]
}

export type AuthPrincipal = SessionPrincipal | ServicePrincipal

export interface RequestMetadata {
  ipAddress?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export const SESSION_COOKIE = '__Host-mado_session'

export function hasPermission(principal: SessionPrincipal, permission: string): boolean {
  return principal.user.permissions.includes(permission)
}

export function hasScope(principal: ServicePrincipal, scope: string): boolean {
  return principal.scopes.includes(scope)
}

export function allowsNamespace(principal: ServicePrincipal, namespace: string): boolean {
  return principal.namespaces.includes('*') || principal.namespaces.includes(namespace)
}
