import { describe, expect, it } from 'vitest'
import type { LineageLink } from './api/types'
import {
  ancestorGenerations, collapseToBuckets, descendantGenerations,
  directChildren, directParents, edgesTouching, nodeKey, nodeKind, sameNode,
} from './lineageGraph'

function link(id: number, parent: [string, string], child: [string, string]): LineageLink {
  return {
    id,
    parentBucket: parent[0], parentPath: parent[1],
    childBucket: child[0], childPath: child[1],
    createdBy: 'test', createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('nodeKind', () => {
  it('空文字はバケット', () => expect(nodeKind('')).toBe('bucket'))
  it('末尾スラッシュはディレクトリ', () => expect(nodeKind('a/b/')).toBe('directory'))
  it('それ以外はファイル', () => expect(nodeKind('a/b.txt')).toBe('file'))
})

describe('nodeKey / sameNode', () => {
  it('bucket + path をユニークに識別する', () => {
    expect(nodeKey({ bucket: 'a', path: 'x/' })).not.toBe(nodeKey({ bucket: 'b', path: 'x/' }))
    expect(sameNode({ bucket: 'a', path: 'x/' }, { bucket: 'a', path: 'x/' })).toBe(true)
    expect(sameNode({ bucket: 'a', path: 'x/' }, { bucket: 'a', path: 'y/' })).toBe(false)
  })
})

describe('directParents / directChildren / edgesTouching', () => {
  const edges = [
    link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
    link(2, ['raw', '2024-02/'], ['clean', 'v2/']),
    link(3, ['clean', 'v2/'], ['export', 'final/']),
  ]
  it('directParents: 子を指定すると親エッジだけ返す', () => {
    expect(directParents(edges, { bucket: 'clean', path: 'v2/' }).map(e => e.id)).toEqual([1, 2])
  })
  it('directChildren: 親を指定すると子エッジだけ返す', () => {
    expect(directChildren(edges, { bucket: 'clean', path: 'v2/' }).map(e => e.id)).toEqual([3])
  })
  it('edgesTouching: 親でも子でも当事者なら全部返す', () => {
    expect(edgesTouching(edges, { bucket: 'clean', path: 'v2/' }).map(e => e.id)).toEqual([1, 2, 3])
  })
})

describe('ancestorGenerations / descendantGenerations', () => {
  it('世代ごとに分けて返す', () => {
    const edges = [link(1, ['a', ''], ['b', '']), link(2, ['b', ''], ['c', ''])]
    expect(descendantGenerations(edges, { bucket: 'a', path: '' }))
      .toEqual([[{ bucket: 'b', path: '' }], [{ bucket: 'c', path: '' }]])
    expect(ancestorGenerations(edges, { bucket: 'c', path: '' }))
      .toEqual([[{ bucket: 'b', path: '' }], [{ bucket: 'a', path: '' }]])
  })

  it('循環があっても無限ループせず、同じノードを2度出さない', () => {
    const edges = [
      link(1, ['a', ''], ['b', '']),
      link(2, ['b', ''], ['c', '']),
      link(3, ['c', ''], ['a', '']), // 循環: a -> b -> c -> a
    ]
    const gens = descendantGenerations(edges, { bucket: 'a', path: '' })
    expect(gens).toEqual([[{ bucket: 'b', path: '' }], [{ bucket: 'c', path: '' }]])
  })

  it('複数の親・複数の子 (DAG のマージ/分岐) を1世代にまとめる', () => {
    const edges = [
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['raw', '2024-02/'], ['clean', 'v2/']),
    ]
    expect(ancestorGenerations(edges, { bucket: 'clean', path: 'v2/' })).toEqual([[
      { bucket: 'raw', path: '2024-01/' },
      { bucket: 'raw', path: '2024-02/' },
    ]])
  })

  it('リンクが無ければ空配列', () => {
    expect(ancestorGenerations([], { bucket: 'a', path: '' })).toEqual([])
    expect(descendantGenerations([], { bucket: 'a', path: '' })).toEqual([])
  })
})

describe('collapseToBuckets', () => {
  it('バケット間のペアに畳み、重複を除く', () => {
    const edges = [
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['raw', '2024-02/'], ['clean', 'v2/']),
      link(3, ['clean', 'v2/'], ['export', 'final/']),
    ]
    expect(collapseToBuckets(edges)).toEqual([
      { parentBucket: 'raw', childBucket: 'clean' },
      { parentBucket: 'clean', childBucket: 'export' },
    ])
  })

  it('同一バケット内で閉じたリンクは除外する', () => {
    expect(collapseToBuckets([link(1, ['raw', 'a/'], ['raw', 'b/'])])).toEqual([])
  })
})
