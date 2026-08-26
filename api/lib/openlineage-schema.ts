import { z } from 'zod'

const NonEmpty = z.string().trim().min(1).max(1024)
const Facets = z.record(z.string(), z.unknown()).default({})

const Dataset = z.object({
  namespace: NonEmpty,
  name: NonEmpty,
  facets: Facets,
  inputFacets: z.record(z.string(), z.unknown()).optional(),
  outputFacets: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const OpenLineageEventSchema = z.object({
  eventTime: z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid eventTime'),
  eventType: z.enum(['START', 'RUNNING', 'COMPLETE', 'ABORT', 'FAIL', 'OTHER']),
  run: z.object({
    runId: z.string().uuid(),
    facets: Facets,
  }).passthrough(),
  job: z.object({
    namespace: NonEmpty,
    name: NonEmpty,
    facets: Facets,
  }).passthrough(),
  inputs: z.array(Dataset).default([]),
  outputs: z.array(Dataset).default([]),
  producer: z.string().min(1),
  schemaURL: z.string().min(1),
}).passthrough()

export type OpenLineageEvent = z.infer<typeof OpenLineageEventSchema>
export type OpenLineageDataset = OpenLineageEvent['inputs'][number]

export interface OpenLineageProfileIssue {
  path: string
  message: string
}

export type OpenLineageValidation =
  | { ok: true; event: OpenLineageEvent }
  | { ok: false; issues: OpenLineageProfileIssue[] }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Return the immutable dataset-version identity used by the Registry profile.
 *
 * Standard OpenLineage integrations can use the standard `version` facet.
 * Registry-aware producers can alternatively provide a Registry UUID in the
 * `datasetRegistry` or `madoDataset` custom facet.
 */
export function datasetVersionIdentity(dataset: OpenLineageDataset): string | null {
  const versionFacet = asRecord(dataset.facets.version)
  const standard = versionFacet?.datasetVersion
  if (typeof standard === 'string' && standard.trim()) return standard

  for (const key of ['datasetRegistry', 'madoDataset']) {
    const facet = asRecord(dataset.facets[key])
    const id = facet?.datasetVersionId
    if (typeof id === 'string' && id.trim()) return id
  }
  return null
}

/** Parse OpenLineage and enforce the canonical Registry profile. */
export function validateOpenLineageProfile(value: unknown): OpenLineageValidation {
  const parsed = OpenLineageEventSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }

  const issues: OpenLineageProfileIssue[] = []
  const check = (dataset: OpenLineageDataset, path: string): void => {
    // Purchased/crawled sources are represented as synthetic datasets and do
    // not have an internal DatasetVersion.
    if (dataset.namespace === 'external-source') return
    if (!datasetVersionIdentity(dataset)) {
      issues.push({
        path,
        message: 'dataset version identity is required (version facet or Registry datasetVersionId)',
      })
    }
  }
  parsed.data.inputs.forEach((dataset, index) => check(dataset, `inputs.${index}`))
  parsed.data.outputs.forEach((dataset, index) => check(dataset, `outputs.${index}`))

  return issues.length > 0 ? { ok: false, issues } : { ok: true, event: parsed.data }
}

export function writableNamespaces(event: OpenLineageEvent): string[] {
  return [...new Set([
    event.job.namespace,
    ...event.outputs
      .filter(dataset => dataset.namespace !== 'external-source')
      .map(dataset => dataset.namespace),
  ])]
}

export function namespaceAllowed(namespace: string, allowed: readonly string[]): boolean {
  return allowed.includes('*') || allowed.includes(namespace)
}

export function forbiddenWritableNamespaces(
  event: OpenLineageEvent,
  allowed: readonly string[],
): string[] {
  return writableNamespaces(event).filter(namespace => !namespaceAllowed(namespace, allowed))
}
