import { describe, expect, it } from 'vitest'
import { parseLineageRoute, patchLineageRoute } from './route'

describe('lineage の URL 状態', () => {
  it('空や壊れた query には安全な既定値を使う', () => {
    expect(parseLineageRoute(new URLSearchParams('depth=999&mode=x'))).toEqual({
      mode: 'logical', rootKind: 'dataset', namespace: '', name: '', versionId: '', depth: 6, selectedId: '',
    })
    expect(parseLineageRoute(new URLSearchParams('depth=nope')).depth).toBe(3)
  })

  it('versions 表示とノード ID は query にして戻せる', () => {
    const next = patchLineageRoute(new URLSearchParams(), {
      mode: 'versions', versionId: 'ver/a:b', selectedId: 'opaque:node/1', depth: 4,
    })
    expect(parseLineageRoute(next)).toMatchObject({
      mode: 'versions', versionId: 'ver/a:b', selectedId: 'opaque:node/1', depth: 4,
    })
  })

  it('既定値は省き、関係ない query キーは消さない', () => {
    const next = patchLineageRoute(new URLSearchParams('keep=1&mode=versions'), {
      mode: 'logical', rootKind: 'dataset', depth: 3,
    })
    expect(next.toString()).toBe('keep=1')
  })
})
