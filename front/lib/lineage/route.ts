import type { LineageProjection } from '../api/types'

export interface LineageRouteState {
  mode: LineageProjection
  rootKind: 'dataset' | 'job'
  namespace: string
  name: string
  versionId: string
  depth: number
  selectedId: string
}

const MIN_DEPTH = 1
const MAX_DEPTH = 6

function depthOf(raw: string | null): number {
  if (raw === null || raw === '') return 3
  const value = Number(raw)
  if (!Number.isInteger(value)) return 3
  return Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, value))
}

export function parseLineageRoute(params: URLSearchParams): LineageRouteState {
  return {
    mode: params.get('mode') === 'versions' ? 'versions' : 'logical',
    rootKind: params.get('rootKind') === 'job' ? 'job' : 'dataset',
    namespace: params.get('namespace')?.trim() ?? '',
    name: params.get('name')?.trim() ?? '',
    versionId: params.get('versionId')?.trim() ?? '',
    depth: depthOf(params.get('depth')),
    selectedId: params.get('node') ?? '',
  }
}

export function patchLineageRoute(
  current: URLSearchParams,
  patch: Partial<LineageRouteState>,
): URLSearchParams {
  const next = new URLSearchParams(current)
  const set = (key: string, value: string, defaultValue = '') => {
    if (value === defaultValue) next.delete(key)
    else next.set(key, value)
  }
  if (patch.mode !== undefined) set('mode', patch.mode, 'logical')
  if (patch.rootKind !== undefined) set('rootKind', patch.rootKind, 'dataset')
  if (patch.namespace !== undefined) set('namespace', patch.namespace.trim())
  if (patch.name !== undefined) set('name', patch.name.trim())
  if (patch.versionId !== undefined) set('versionId', patch.versionId.trim())
  if (patch.depth !== undefined) set('depth', String(Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, patch.depth))), '3')
  if (patch.selectedId !== undefined) set('node', patch.selectedId)
  return next
}
