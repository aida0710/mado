import {
  DatasetCatalogResponse,
  DatasetDetail,
  DatasetVersionDetail,
  LineageGraph,
  LineageRunDetail,
  ManualLineageMutationResult,
  StorageLineageResolution,
} from './types'
import type {
  LineageDatasetUpdateInput,
  LineageProjection,
  ManualDatasetRegistrationInput,
  ManualLineageRegistrationInput,
  ManualStorageLocationInput,
} from './types'
import { API_BASE, buildUrl, getJson, mutateJson } from './http'

// Dataset lineage。Marquez / Registry の違いは API 側で吸収し、ブラウザは統一した
// domain graph だけを受け取る。React Flow 用の座標はここでは持たない。
export const lineageClient = {
  lineageGraph: (params: {
    mode: LineageProjection
    rootKind?: 'dataset' | 'job'
    namespace?: string
    name?: string
    versionId?: string
    depth?: number
  }) => getJson(
    buildUrl(`${API_BASE}/lineage/graph`, {
      mode: params.mode,
      rootKind: params.rootKind,
      namespace: params.namespace,
      name: params.name,
      versionId: params.versionId,
      depth: params.depth == null ? undefined : String(params.depth),
    }),
    LineageGraph,
  ),

  lineageDataset: (datasetId: string) =>
    getJson(`${API_BASE}/lineage/datasets/${encodeURIComponent(datasetId)}`, DatasetDetail),

  updateLineageDataset: (datasetId: string, input: LineageDatasetUpdateInput) =>
    mutateJson(
      `${API_BASE}/lineage/curation/datasets/${encodeURIComponent(datasetId)}`,
      { method: 'PATCH', body: input },
      DatasetDetail,
    ),

  lineageVersion: (versionId: string) =>
    getJson(`${API_BASE}/lineage/versions/${encodeURIComponent(versionId)}`, DatasetVersionDetail),

  lineageRun: (runId: string) =>
    getJson(`${API_BASE}/lineage/runs/${encodeURIComponent(runId)}`, LineageRunDetail),

  lineageCatalog: (params: { q?: string; namespace?: string; limit?: number; offset?: number } = {}) =>
    getJson(buildUrl(`${API_BASE}/lineage/catalog`, {
      q: params.q,
      namespace: params.namespace,
      limit: params.limit == null ? undefined : String(params.limit),
      offset: params.offset == null ? undefined : String(params.offset),
    }), DatasetCatalogResponse),

  lineageResolveLocation: (connectionId: string, bucket: string, key: string) =>
    getJson(buildUrl(`${API_BASE}/lineage/resolve-location`, { connectionId, bucket, key }), StorageLineageResolution),

  registerManualDataset: (input: ManualDatasetRegistrationInput) =>
    mutateJson(`${API_BASE}/lineage/curation/datasets`, { method: 'POST', body: input }, ManualLineageMutationResult),

  registerManualLocation: (input: {
    versionId: string
    location: ManualStorageLocationInput
    evidenceRefs: string[]
  }) => mutateJson(`${API_BASE}/lineage/curation/locations`, { method: 'POST', body: input }, ManualLineageMutationResult),

  registerManualLineage: (input: ManualLineageRegistrationInput) =>
    mutateJson(`${API_BASE}/lineage/curation/runs`, { method: 'POST', body: input }, ManualLineageMutationResult),
}
