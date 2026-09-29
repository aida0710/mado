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

export interface RequestMetadata {
  ipAddress?: string | null
  userAgent?: string | null
  requestId?: string | null
}

// HTTPS のときだけ __Host- を付ける。__Host- の cookie は Secure が必須で、HTTP では送られないため。
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-mado_session' : 'mado_session'
}

/** SSO の login を開始した browser と callback を結ぶ cookie。 */
export function oidcTransactionCookieName(secure: boolean): string {
  return secure ? '__Host-mado_oidc_tx' : 'mado_oidc_tx'
}

export function hasPermission(principal: SessionPrincipal, permission: string): boolean {
  return principal.user.permissions.includes(permission)
}
