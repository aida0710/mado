import { describe, expect, it } from 'vitest'
import { parseLineageRoute, patchLineageRoute } from './route'

describe('lineage route state', () => {
  it('uses safe defaults for an empty or malformed query', () => {
    expect(parseLineageRoute(new URLSearchParams('depth=999&mode=x'))).toEqual({
      mode: 'logical', rootKind: 'dataset', namespace: '', name: '', versionId: '', depth: 6, selectedId: '',
    })
    expect(parseLineageRoute(new URLSearchParams('depth=nope')).depth).toBe(3)
  })

  it('round-trips versions mode and opaque node IDs', () => {
    const next = patchLineageRoute(new URLSearchParams(), {
      mode: 'versions', versionId: 'ver/a:b', selectedId: 'opaque:node/1', depth: 4,
    })
    expect(parseLineageRoute(next)).toMatchObject({
      mode: 'versions', versionId: 'ver/a:b', selectedId: 'opaque:node/1', depth: 4,
    })
  })

  it('omits default values without erasing unrelated query keys', () => {
    const next = patchLineageRoute(new URLSearchParams('keep=1&mode=versions'), {
      mode: 'logical', rootKind: 'dataset', depth: 3,
    })
    expect(next.toString()).toBe('keep=1')
  })
})
