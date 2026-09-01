import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { AuditWriter } from '../lib/audit.js'
import { requestMetadata } from '../lib/request-metadata.js'
import { getSessionPrincipal, requirePermission } from '../lib/rbac.js'
import type {
  RegistryClient,
  RegistryManualLocationInput,
} from '../lib/registry-client.js'
import { RegistryClientError } from '../lib/registry-client.js'
import { markAuditChangeCommitted } from '../lib/audit-activity.js'

const Text = z.string().trim().min(1).max(1024)
const OptionalText = z.string().trim().max(8192).optional()
const Uuid = z.string().uuid()
const EvidenceRefs = z.array(z.string().trim().url().max(8192)).max(100).default([])

const StorageLocation = z.object({
  connectionId: z.string().min(1).max(256),
  bucket: z.string().trim().min(1).max(1024),
  key: z.string().trim().max(8192).default(''),
  status: z.enum(['available', 'archived', 'missing', 'deleted', 'unknown']).default('available'),
  isPrimary: z.boolean().default(false),
}).strict()

const DatasetFields = z.object({
  datasetKey: Text,
  namespace: Text,
  name: Text,
  displayName: z.string().trim().min(1).max(512).optional(),
  aliases: z.array(z.string().trim().min(1).max(1024)).max(100).default([]),
  description: OptionalText,
  mediaType: z.string().trim().max(512).optional(),
  owner: z.string().trim().max(512).optional(),
}).strict()

const VersionFields = z.object({
  version: Text,
  contentHash: OptionalText,
  manifestUri: OptionalText,
  manifestHash: OptionalText,
  schemaUri: OptionalText,
}).strict()

const SourceFields = z.object({
  sourceKey: Text,
  kind: z.enum(['purchased', 'crawled', 'provided', 'generated', 'database', 'other']),
  name: Text,
  uri: OptionalText,
  vendor: z.string().trim().max(1024).optional(),
  product: z.string().trim().max(1024).optional(),
  licenseRef: OptionalText,
  contractRef: OptionalText,
}).strict()

const TransformationFields = z.object({
  transformationKey: Text,
  name: Text,
  description: OptionalText,
  codeRepository: OptionalText,
  defaultCodeRef: OptionalText,
}).strict()

const ProcessingFields = z.object({
  transformation: TransformationFields,
  inputVersionIds: z.array(Uuid).max(1000).default([]),
  jobNamespace: Text,
  jobName: Text,
  gitSha: OptionalText,
  containerDigest: OptionalText,
  configUri: OptionalText,
  configHash: OptionalText,
  executionTimeStatus: z.enum(['known', 'unknown']).default('unknown'),
  occurredAt: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.executionTimeStatus === 'known' && !value.occurredAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurredAt'], message: 'occurredAt is required' })
  }
})

const DatasetRegistration = z.object({
  datasetId: Uuid.optional(),
  dataset: DatasetFields.optional(),
  version: VersionFields,
  location: StorageLocation.optional(),
  source: SourceFields.optional(),
  processing: ProcessingFields.optional(),
  evidenceRefs: EvidenceRefs,
}).strict().superRefine((value, ctx) => {
  if ((value.datasetId === undefined) === (value.dataset === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataset'], message: 'new or existing dataset is required' })
  }
})

const LocationRegistration = z.object({
  versionId: Uuid,
  location: StorageLocation,
  evidenceRefs: EvidenceRefs,
}).strict()

const LineageRegistration = z.object({
  transformation: TransformationFields,
  inputVersionIds: z.array(Uuid).min(1).max(1000),
  outputVersionIds: z.array(Uuid).min(1).max(1000),
  jobNamespace: Text,
  jobName: Text,
  gitSha: OptionalText,
  containerDigest: OptionalText,
  configUri: OptionalText,
  configHash: OptionalText,
  executionTimeStatus: z.enum(['known', 'unknown']).default('unknown'),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  evidenceRefs: EvidenceRefs,
}).strict().superRefine((value, ctx) => {
  if (value.inputVersionIds.some(id => value.outputVersionIds.includes(id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputVersionIds'], message: 'input and output must differ' })
  }
  if (value.executionTimeStatus === 'known' && !value.occurredAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurredAt'], message: 'occurredAt is required' })
  }
})

const DatasetUpdate = z.object({
  displayName: z.string().trim().min(1).max(512).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(1024)).max(100).optional(),
  description: z.string().trim().max(8192).nullable().optional(),
  mediaType: z.string().trim().max(512).nullable().optional(),
  owner: z.string().trim().max(512).nullable().optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), {
  message: 'one or more fields are required',
})

interface StorageBindingRow {
  registry_storage_system_key: string
  endpoint: string
  region: string
}

export interface LineageCurationDeps {
  registry: RegistryClient
  pool: Pool
  audit: AuditWriter
}

const datasetMutationTails = new Map<string, Promise<void>>()

async function withDatasetMutationLock<T>(datasetId: string, operation: () => Promise<T>): Promise<T> {
  const previous = datasetMutationTails.get(datasetId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => current)
  datasetMutationTails.set(datasetId, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (datasetMutationTails.get(datasetId) === tail) datasetMutationTails.delete(datasetId)
  }
}

function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ''))
}

async function locationInput(
  pool: Pool,
  location: z.infer<typeof StorageLocation>,
): Promise<RegistryManualLocationInput | null> {
  const result = await pool.query<StorageBindingRow>(
    `SELECT b.registry_storage_system_key, c.endpoint, c.region
       FROM lineage_storage_bindings b
       JOIN storage_connections c ON c.id = b.connection_id
      WHERE b.connection_id = $1`,
    [location.connectionId],
  )
  const binding = result.rows[0]
  if (!binding) return null
  const key = location.key.replace(/^\/+/, '')
  return {
    uri: `s3://${location.bucket}/${key}`,
    storage_kind: 's3',
    storage_system_key: binding.registry_storage_system_key,
    storage_system_kind: 's3',
    storage_endpoint: binding.endpoint,
    region: binding.region,
    bucket: location.bucket,
    status: location.status,
    is_primary: location.isPrimary,
    metadata: { madoConnectionId: location.connectionId },
  }
}

function sourceInput(source: z.infer<typeof SourceFields>): Record<string, unknown> {
  return compact({
    source_key: source.sourceKey,
    kind: source.kind,
    name: source.name,
    uri: source.uri,
    vendor: source.vendor,
    product: source.product,
    license_ref: source.licenseRef,
    contract_ref: source.contractRef,
    metadata: {},
  })
}

function transformationInput(value: z.infer<typeof TransformationFields>): Record<string, unknown> {
  return compact({
    transformation_key: value.transformationKey,
    name: value.name,
    description: value.description,
    code_repository: value.codeRepository,
    default_code_ref: value.defaultCodeRef,
    metadata: {},
  })
}

function processingInput(value: z.infer<typeof ProcessingFields>): Record<string, unknown> {
  return compact({
    transformation: transformationInput(value.transformation),
    input_version_ids: value.inputVersionIds,
    job_namespace: value.jobNamespace,
    job_name: value.jobName,
    git_sha: value.gitSha,
    container_digest: value.containerDigest,
    config_uri: value.configUri,
    config_hash: value.configHash,
    model_refs: [],
    runtime: {},
    execution_time_status: value.executionTimeStatus,
    occurred_at: value.occurredAt,
  })
}

function mutationError(c: Context, error: unknown): Response {
  if (!(error instanceof RegistryClientError)) throw error
  if (error.status === 404) return c.json({ error: '指定したDatasetまたはVersionが見つかりません。' }, 404)
  if (error.status === 409) return c.json({ error: '同じ識別子または保存場所がすでに登録されています。' }, 409)
  if (error.status === 422) return c.json({ error: '参照先または入力内容を確認してください。' }, 422)
  return c.json({ error: 'Dataset Registryへ登録できませんでした。' }, 502)
}

export function mountLineageCurationRoutes(app: Hono, deps: LineageCurationDeps): void {
  app.use('/lineage/curation/*', requirePermission('lineage:curate'))

  app.patch('/lineage/curation/datasets/:datasetId', async c => {
    const principal = getSessionPrincipal(c)!
    const datasetId = c.req.param('datasetId')
    if (!Uuid.safeParse(datasetId).success) return c.json({ error: 'Dataset IDを確認してください。' }, 400)
    const parsed = DatasetUpdate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: '入力内容を確認してください。' }, 400)
    return withDatasetMutationLock(datasetId, async () => {
      try {
        const current = await deps.registry.getDataset(datasetId)
        const unchanged = Object.entries(parsed.data).every(([key, value]) => {
          const existing = current[key as keyof typeof current]
          return Array.isArray(value) && Array.isArray(existing)
            ? JSON.stringify(value) === JSON.stringify(existing)
            : value === existing
        })
        if (unchanged) return c.json(current)
        const result = await deps.registry.updateDataset(datasetId, parsed.data)
        markAuditChangeCommitted(c)
        await deps.audit.write({
          actor: { type: 'user', userId: principal.user.id },
          action: 'lineage.dataset.update', outcome: 'success',
          resourceType: 'dataset', resourceId: datasetId,
          details: { changedFields: Object.keys(parsed.data) },
          ...requestMetadata(c),
        })
        return c.json(result)
      } catch (error) {
        return mutationError(c, error)
      }
    })
  })

  app.post('/lineage/curation/datasets', async c => {
    const principal = getSessionPrincipal(c)!
    const parsed = DatasetRegistration.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: '入力内容を確認してください。' }, 400)
    const location = parsed.data.location
      ? await locationInput(deps.pool, parsed.data.location) : undefined
    if (parsed.data.location && !location) {
      return c.json({ error: 'この接続はDataset Registryへ紐付けられていません。' }, 422)
    }
    try {
      const result = await deps.registry.registerManualDataset({
        registration_key: `mado-manual-${randomUUID()}`,
        ...(parsed.data.datasetId ? { dataset_id: parsed.data.datasetId } : {}),
        ...(parsed.data.dataset ? { dataset: compact({
          dataset_key: parsed.data.dataset.datasetKey,
          namespace: parsed.data.dataset.namespace,
          name: parsed.data.dataset.name,
          display_name: parsed.data.dataset.displayName,
          aliases: parsed.data.dataset.aliases,
          description: parsed.data.dataset.description,
          media_type: parsed.data.dataset.mediaType,
          owner: parsed.data.dataset.owner,
        }) } : {}),
        version: compact({
          version: parsed.data.version.version,
          content_hash: parsed.data.version.contentHash,
          manifest_uri: parsed.data.version.manifestUri,
          manifest_hash: parsed.data.version.manifestHash,
          schema_uri: parsed.data.version.schemaUri,
          metadata: {},
        }),
        locations: location ? [location] : [],
        ...(parsed.data.source ? { source: sourceInput(parsed.data.source) } : {}),
        ...(parsed.data.processing ? { processing: processingInput(parsed.data.processing) } : {}),
        evidence_refs: parsed.data.evidenceRefs,
        submitted_by: principal.user.id,
      })
      markAuditChangeCommitted(c)
      const dataset = result.dataset as Record<string, unknown> | undefined
      const version = result.version as Record<string, unknown> | undefined
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id },
        action: 'lineage.dataset.register', outcome: 'success',
        resourceType: 'dataset', resourceId: typeof dataset?.datasetId === 'string'
          ? dataset.datasetId : typeof dataset?.dataset_id === 'string' ? dataset.dataset_id : null,
        details: {
          dataset: parsed.data.dataset
            ? { namespace: parsed.data.dataset.namespace, name: parsed.data.dataset.name }
            : { datasetId: parsed.data.datasetId },
          version: parsed.data.version.version,
          versionId: version?.id,
          storageUri: location?.uri,
          source: parsed.data.source?.name,
          processing: parsed.data.processing?.transformation.name,
          evidenceRefs: parsed.data.evidenceRefs,
        },
        ...requestMetadata(c),
      })
      return c.json(result, 201)
    } catch (error) {
      return mutationError(c, error)
    }
  })

  app.post('/lineage/curation/locations', async c => {
    const principal = getSessionPrincipal(c)!
    const parsed = LocationRegistration.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: '入力内容を確認してください。' }, 400)
    const location = await locationInput(deps.pool, parsed.data.location)
    if (!location) return c.json({ error: 'この接続はDataset Registryへ紐付けられていません。' }, 422)
    try {
      const result = await deps.registry.registerManualLocation({
        version_id: parsed.data.versionId,
        location,
        evidence_refs: parsed.data.evidenceRefs,
        submitted_by: principal.user.id,
      })
      markAuditChangeCommitted(c)
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id },
        action: 'lineage.location.register', outcome: 'success',
        resourceType: 'dataset_version', resourceId: parsed.data.versionId,
        details: { storageUri: location.uri, evidenceRefs: parsed.data.evidenceRefs },
        ...requestMetadata(c),
      })
      return c.json(result, 201)
    } catch (error) {
      return mutationError(c, error)
    }
  })

  app.post('/lineage/curation/runs', async c => {
    const principal = getSessionPrincipal(c)!
    const parsed = LineageRegistration.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: '入力内容を確認してください。' }, 400)
    try {
      const result = await deps.registry.registerManualLineage({
        run_key: `mado-manual-${randomUUID()}`,
        transformation: transformationInput(parsed.data.transformation),
        input_version_ids: parsed.data.inputVersionIds,
        output_version_ids: parsed.data.outputVersionIds,
        sources: [],
        job_namespace: parsed.data.jobNamespace,
        job_name: parsed.data.jobName,
        git_sha: parsed.data.gitSha,
        container_digest: parsed.data.containerDigest,
        config_uri: parsed.data.configUri,
        config_hash: parsed.data.configHash,
        model_refs: [],
        runtime: {},
        metrics: {},
        evidence_refs: parsed.data.evidenceRefs,
        execution_time_status: parsed.data.executionTimeStatus,
        occurred_at: parsed.data.occurredAt,
        submitted_by: principal.user.id,
      })
      markAuditChangeCommitted(c)
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id },
        action: 'lineage.run.register', outcome: 'success',
        resourceType: 'run', resourceId: typeof result.id === 'string' ? result.id : null,
        details: {
          transformation: parsed.data.transformation.name,
          inputs: parsed.data.inputVersionIds,
          outputs: parsed.data.outputVersionIds,
          job: `${parsed.data.jobNamespace}/${parsed.data.jobName}`,
          executionTimeStatus: parsed.data.executionTimeStatus,
          evidenceRefs: parsed.data.evidenceRefs,
        },
        ...requestMetadata(c),
      })
      return c.json(result, 201)
    } catch (error) {
      return mutationError(c, error)
    }
  })
}
