export type UserStatus = 'active' | 'disabled'

export interface AuthUser {
  id: string
  username: string | null
  email: string | null
  displayName: string
  signatureName: string
  status: UserStatus
  roles: string[]
  permissions: string[]
  mustChangePassword: boolean
  authMethods: Array<'local' | 'sso'>
}

export interface SessionPrincipal {
  kind: 'user'
  sessionId: string
  user: AuthUser
}

/**
 * Service Account keyへ付けられるscope。Madoが保存しているデータは読み取りだけを開き、
 * 書き込みはRegistryへのOpenLineage投入口 (`lineage:write`) に限る。
 */
export const SERVICE_KEY_SCOPES = ['lineage:write', 'metrics:read'] as const
export type ServiceKeyScope = typeof SERVICE_KEY_SCOPES[number]

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
