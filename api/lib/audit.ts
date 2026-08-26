import type { Pool, PoolClient } from 'pg'
import type { RequestMetadata } from './auth-types.js'

export type AuditActor =
  | { type: 'user'; userId: string }
  | { type: 'service_account'; serviceAccountId: string }
  | { type: 'anonymous' }
  | { type: 'system' }

export interface AuditEventInput extends RequestMetadata {
  actor: AuditActor
  action: string
  outcome: 'success' | 'denied' | 'failure'
  resourceType?: string | null
  resourceId?: string | null
  details?: Record<string, unknown>
}

export interface AuditWriter {
  write(event: AuditEventInput, client?: PoolClient): Promise<void>
}

const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|credential|code_verifier)/i

/** audit detailsに秘密値を混ぜない最後の砦。ネストしたobject/arrayも処理する。 */
export function redactAuditDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditDetails)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactAuditDetails(child)
    }
    return out
  }
  return value
}

export function createAuditWriter(pool: Pool): AuditWriter {
  return {
    async write(event, client) {
      const actorUserId = event.actor.type === 'user' ? event.actor.userId : null
      const actorServiceId = event.actor.type === 'service_account'
        ? event.actor.serviceAccountId
        : null
      const details = redactAuditDetails(event.details ?? {})
      const q = client ?? pool
      await q.query(
        `INSERT INTO audit_events
          (request_id, actor_type, actor_user_id, actor_service_account_id,
           action, resource_type, resource_id, outcome, ip_address, user_agent, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          event.requestId ?? null,
          event.actor.type,
          actorUserId,
          actorServiceId,
          event.action,
          event.resourceType ?? null,
          event.resourceId ?? null,
          event.outcome,
          event.ipAddress ?? null,
          event.userAgent?.slice(0, 1024) ?? null,
          JSON.stringify(details),
        ],
      )
    },
  }
}
