import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { LineageService } from '../lib/lineage-service.js'
import { MarquezClientError } from '../lib/marquez-client.js'
import { RegistryClientError } from '../lib/registry-client.js'

const Identity = z.string().trim().min(1).max(1024)
const Uuid = z.string().uuid()

export interface LineageRoutesDeps {
  service: LineageService
}

function boundedInt(value: string | undefined, { fallback, min, max }: { fallback: number; min: number; max: number }): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function backendError(c: Context, error: unknown): Response {
  if (error instanceof RegistryClientError) {
    if (error.status === 404) return c.json({ error: 'not found' }, 404)
    return c.json({ error: 'Dataset Registry is unavailable' }, 502)
  }
  if (error instanceof MarquezClientError) {
    return c.json({ error: 'Marquez is unavailable' }, 502)
  }
  throw error
}

export function mountLineageRoutes(app: Hono, deps: LineageRoutesDeps): void {
  app.get('/lineage/graph', async c => {
    const mode = c.req.query('mode') ?? 'logical'
    const depth = boundedInt(c.req.query('depth'), { fallback: 3, min: 1, max: 10 })
    try {
      if (mode === 'versions') {
        const versionId = Uuid.safeParse(c.req.query('versionId'))
        if (!versionId.success) return c.json({ error: 'valid versionId is required' }, 400)
        const rawDirection = c.req.query('direction') ?? 'both'
        if (!['upstream', 'downstream', 'both'].includes(rawDirection)) {
          return c.json({ error: 'invalid direction' }, 400)
        }
        return c.json(await deps.service.versionGraph({
          versionId: versionId.data,
          direction: rawDirection as 'upstream' | 'downstream' | 'both',
          depth,
        }))
      }
      if (mode !== 'logical') return c.json({ error: 'invalid graph mode' }, 400)

      // rootKindが公開契約。kindは実装初期のclientとの後方互換。
      const kind = c.req.query('rootKind') ?? c.req.query('kind')
      const namespace = Identity.safeParse(c.req.query('namespace'))
      const name = Identity.safeParse(c.req.query('name'))
      if (kind !== 'dataset' && kind !== 'job') {
        return c.json({ error: 'kind must be dataset or job' }, 400)
      }
      if (!namespace.success || !name.success) {
        return c.json({ error: 'namespace and name are required' }, 400)
      }
      return c.json(await deps.service.logicalGraph({
        kind,
        namespace: namespace.data,
        name: name.data,
        depth,
      }))
    } catch (error) {
      return backendError(c, error)
    }
  })

  app.get('/lineage/search', async c => {
    const q = (c.req.query('q') ?? '').trim()
    const namespace = c.req.query('namespace')?.trim() || undefined
    const limit = boundedInt(c.req.query('limit'), { fallback: 50, min: 1, max: 100 })
    try {
      return c.json(await deps.service.search({ q, namespace, limit }))
    } catch (error) {
      return backendError(c, error)
    }
  })

  app.get('/lineage/catalog', async c => {
    const q = (c.req.query('q') ?? '').trim()
    const namespace = c.req.query('namespace')?.trim() || undefined
    const limit = boundedInt(c.req.query('limit'), { fallback: 20, min: 1, max: 100 })
    const offset = boundedInt(c.req.query('offset'), { fallback: 0, min: 0, max: 1_000_000 })
    try {
      return c.json(await deps.service.catalog({ q, namespace, limit, offset }))
    } catch (error) {
      return backendError(c, error)
    }
  })

  app.get('/lineage/resolve-location', async c => {
    const connectionId = z.string().min(1).max(256).safeParse(c.req.query('connectionId'))
    const bucket = z.string().min(1).max(1024).safeParse(c.req.query('bucket'))
    const key = z.string().max(8192).safeParse(c.req.query('key') ?? '')
    const limit = boundedInt(c.req.query('limit'), { fallback: 20, min: 1, max: 100 })
    if (!connectionId.success || !bucket.success || !key.success) {
      return c.json({ error: 'connectionId, bucket and a valid key are required' }, 400)
    }
    try {
      return c.json(await deps.service.resolveLocation({
        connectionId: connectionId.data,
        bucket: bucket.data,
        key: key.data,
        limit,
      }))
    } catch (error) {
      return backendError(c, error)
    }
  })

  app.get('/lineage/projection-status', async c => {
    return c.json(await deps.service.projectionStatus())
  })

  app.get('/lineage/datasets/:id', async c => {
    const id = Uuid.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'invalid dataset id' }, 400)
    try {
      return c.json(await deps.service.dataset(id.data))
    } catch (error) {
      return backendError(c, error)
    }
  })

  app.get('/lineage/versions/:id', async c => {
    const id = Uuid.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'invalid version id' }, 400)
    try {
      return c.json(await deps.service.version(id.data))
    } catch (error) {
      return backendError(c, error)
    }
  })

  app.get('/lineage/runs/:id', async c => {
    const id = Uuid.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'invalid run id' }, 400)
    try {
      return c.json(await deps.service.run(id.data))
    } catch (error) {
      return backendError(c, error)
    }
  })

  app.get('/lineage/job-runs', async c => {
    const namespace = Identity.safeParse(c.req.query('namespace'))
    const name = Identity.safeParse(c.req.query('name'))
    if (!namespace.success || !name.success) {
      return c.json({ error: 'namespace and name are required' }, 400)
    }
    const limit = boundedInt(c.req.query('limit'), { fallback: 50, min: 1, max: 100 })
    try {
      return c.json(await deps.service.jobRuns(namespace.data, name.data, limit))
    } catch (error) {
      return backendError(c, error)
    }
  })
}
