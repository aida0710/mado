// データの家系図: ノード識別・グラフ走査・バケット集約の純関数群。
// LineageView / LineageGraphCanvas はここでレイアウトを組み立ててから描画する。

import type { LineageLink } from './api/types'

export interface LineageNode {
  bucket: string
  path: string
}

export type LineageNodeKind = 'bucket' | 'directory' | 'file'

// path === '' はバケット直下、末尾 '/' はディレクトリ、それ以外はファイル key
// (api/routes/storage-list.ts と同じ規約)。
export function nodeKind(path: string): LineageNodeKind {
  if (path === '') return 'bucket'
  return path.endsWith('/') ? 'directory' : 'file'
}

// bucket に '|' は S3 の DNS 互換バケット名では使えないので衝突しない。
export function nodeKey(node: LineageNode): string {
  return `${node.bucket}|${node.path}`
}

export function sameNode(a: LineageNode, b: LineageNode): boolean {
  return a.bucket === b.bucket && a.path === b.path
}

// クリックしたノードが当事者になっているエッジ (親としても子としても) を返す。
// ポップアップの「解除」リストに使う — 「全て」「バケット単位」モードには
// 単一の中心ノードという概念が無いため、常にこの形で一意に決める。
export function edgesTouching(edges: LineageLink[], node: LineageNode): LineageLink[] {
  return edges.filter(
    e =>
      (e.parentBucket === node.bucket && e.parentPath === node.path) ||
      (e.childBucket === node.bucket && e.childPath === node.path),
  )
}

export function directParents(edges: LineageLink[], node: LineageNode): LineageLink[] {
  return edges.filter(e => e.childBucket === node.bucket && e.childPath === node.path)
}

export function directChildren(edges: LineageLink[], node: LineageNode): LineageLink[] {
  return edges.filter(e => e.parentBucket === node.bucket && e.parentPath === node.path)
}

// 「現在地」モード: center から祖先方向 / 子孫方向へ辿れるだけ辿り、世代ごとに
// 配列を分ける (generations[0] = 直接の親/子、generations[1] = 祖父母/孫、…)。
// 循環 (A→B→A) があっても無限ループしないよう、訪問済みノードは全世代を通じて
// 一度しか出さない。
function generations(
  edges: LineageLink[],
  center: LineageNode,
  direction: 'up' | 'down',
): LineageNode[][] {
  const visited = new Set<string>([nodeKey(center)])
  const result: LineageNode[][] = []
  let frontier: LineageNode[] = [center]

  while (frontier.length > 0) {
    const next: LineageNode[] = []
    const seenThisGen = new Set<string>()
    for (const n of frontier) {
      const neighbours = direction === 'up' ? directParents(edges, n) : directChildren(edges, n)
      for (const e of neighbours) {
        const neighbour: LineageNode = direction === 'up'
          ? { bucket: e.parentBucket, path: e.parentPath }
          : { bucket: e.childBucket, path: e.childPath }
        const key = nodeKey(neighbour)
        if (visited.has(key) || seenThisGen.has(key)) continue
        seenThisGen.add(key)
        next.push(neighbour)
      }
    }
    if (next.length === 0) break
    next.forEach(n => visited.add(nodeKey(n)))
    result.push(next)
    frontier = next
  }
  return result
}

export function ancestorGenerations(edges: LineageLink[], center: LineageNode): LineageNode[][] {
  return generations(edges, center, 'up')
}

export function descendantGenerations(edges: LineageLink[], center: LineageNode): LineageNode[][] {
  return generations(edges, center, 'down')
}

// 「バケット単位」モード: bucket 名だけを見てエッジを畳む。同一バケット内で
// 閉じたリンク (parentBucket === childBucket) は「バケット同士の関係」を
// 表さないので除外する。重複ペアはまとめる。
export interface BucketEdge {
  parentBucket: string
  childBucket: string
}

export function collapseToBuckets(edges: LineageLink[]): BucketEdge[] {
  const seen = new Set<string>()
  const result: BucketEdge[] = []
  for (const e of edges) {
    if (e.parentBucket === e.childBucket) continue
    const key = `${e.parentBucket}>${e.childBucket}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ parentBucket: e.parentBucket, childBucket: e.childBucket })
  }
  return result
}
