import type { Hono } from 'hono'
import {
  forbiddenWritableNamespaces,
  validateOpenLineageProfile,
} from '../lib/openlineage-schema.js'
import type { RegistryClient } from '../lib/registry-client.js'
import { RegistryClientError } from '../lib/registry-client.js'
import { getServiceKeyPrincipal, requireServiceKeyScope } from '../lib/service-key-auth.js'

export const OPENLINEAGE_INGEST_PATH = '/openlineage/v1/lineage'
export const DEFAULT_OPENLINEAGE_BODY_LIMIT = 2 * 1024 * 1024

export interface LineageServicePrincipal {
  serviceAccountId: string
  keyId: string
  scopes: readonly string[]
  namespaces: readonly string[]
}

/** Adapter boundary for the auth implementation owned by the auth module. */
export interface LineageServiceAuthenticator {
  authenticate(token: string): Promise<LineageServicePrincipal | null>
  recordUse?(event: {
    principal: LineageServicePrincipal
    runId: string | null
    jobNamespace: string | null
    jobName: string | null
    outcome: 'accepted'
  }): Promise<void>
}

export interface OpenLineageRoutesDeps {
  auth: LineageServiceAuthenticator
  registry: RegistryClient
  bodyLimitBytes?: number
  log?: Pick<Console, 'warn'>
}

async function audit(
  deps: OpenLineageRoutesDeps,
  principal: LineageServicePrincipal,
  event: Parameters<NonNullable<LineageServiceAuthenticator['recordUse']>>[0],
): Promise<void> {
  if (!deps.auth.recordUse) return
  try {
    await deps.auth.recordUse(event)
  } catch (error) {
    // Audit availability must be monitored, but a transient audit failure after
    // Registry commit must not make a producer retry an already accepted event.
    ;(deps.log ?? console).warn('failed to record lineage service-key use', error)
  }
}

export function mountOpenLineageRoutes(app: Hono, deps: OpenLineageRoutesDeps): void {
  const requireLineageWrite = requireServiceKeyScope({
    authenticate: token => deps.auth.authenticate(token),
    scope: 'lineage:write',
  })
  app.post(OPENLINEAGE_INGEST_PATH, requireLineageWrite, async c => {
    const principal = getServiceKeyPrincipal<LineageServicePrincipal>(c)
    const bodyLimit = deps.bodyLimitBytes ?? DEFAULT_OPENLINEAGE_BODY_LIMIT
    const announcedSize = Number(c.req.header('Content-Length'))
    if (Number.isFinite(announcedSize) && announcedSize > bodyLimit) {
      return c.json({ error: 'request body too large' }, 413)
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength > bodyLimit) return c.json({ error: 'request body too large' }, 413)

    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }

    const validated = validateOpenLineageProfile(value)
    if (!validated.ok) {
      return c.json({ error: 'invalid OpenLineage event', issues: validated.issues }, 422)
    }
    const event = validated.event
    const forbidden = forbiddenWritableNamespaces(event, principal.namespaces)
    if (forbidden.length > 0) {
      return c.json({
        error: 'service key cannot write one or more namespaces',
        namespaces: forbidden,
      }, 403)
    }

    try {
      const result = await deps.registry.ingestOpenLineage(event, {
        serviceAccountId: principal.serviceAccountId,
        keyId: principal.keyId,
        allowedNamespaces: [...principal.namespaces],
      })
      if (!result.duplicate) {
        await audit(deps, principal, {
          principal,
          runId: event.run.runId,
          jobNamespace: event.job.namespace,
          jobName: event.job.name,
          outcome: 'accepted',
        })
      }
      return c.json(result, 200)
    } catch (error) {
      if (error instanceof RegistryClientError) {
        if (error.status === 403) return c.json({ error: 'namespace is not writable' }, 403)
        if (error.status === 409) return c.json({ error: 'lineage event conflicts with Registry state' }, 409)
        if (error.status === 422) return c.json({ error: 'Registry rejected the lineage event' }, 422)
      }
      return c.json({ error: 'Dataset Registry is unavailable' }, 503)
    }
  })
}
