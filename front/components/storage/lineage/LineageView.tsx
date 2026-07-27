// 家系図ビュー本体。StorageBucket の「一覧 / 家系図」タブから開く。
// 1) エッジを1度だけ全件取得する (表示スコープの絞り込みはここでクライアント側に行う — 詳細は spec 参照)
// 2) スコープ切替 (現在地 / 全て / バケット単位) の状態を持つ
// 3) ノードクリックでポップアップ、「＋ 親/子を追加」でピッカー付きの追加フローを開く

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../../lib/api/client'
import type { LineageLink } from '../../../lib/api/types'
import { encPath } from '../../../lib/route'
import {
  ancestorGenerations, collapseToBuckets, descendantGenerations, nodeKey,
  wouldCreateCycle, type LineageNode,
} from '../../../lib/lineageGraph'
import type { FlowEdge } from './LineageFlowCanvas'

// React Flow は重いので、家系図タブを開いた人だけが払うよう別チャンクにする
// (Monaco を抱える NoteEditPage と同じ方針)。
const LineageFlowCanvas = lazy(() => import('./LineageFlowCanvas'))
import { LineageNodePopup } from './LineageNodePopup'
import { LineageLinkPicker } from './LineageLinkPicker'

interface Props {
  connId: string
  bucket: string
  prefix: string
}

type Scope = 'current' | 'all' | 'bucket'
type Direction = 'parent' | 'child'
interface PendingAdd { direction: Direction; node: LineageNode }

const LAST_EDITOR_KEY = 'dashboard.lastEditor'
const SCOPE_LABEL: Record<Scope, string> = { current: '現在地', all: '全て', bucket: 'バケット単位' }

export function LineageView({ connId, bucket, prefix }: Props) {
  const navigate = useNavigate()
  const center: LineageNode = useMemo(() => ({ bucket, path: prefix }), [bucket, prefix])

  const [edges, setEdges] = useState<LineageLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>('current')
  const [popupNode, setPopupNode] = useState<LineageNode | null>(null)
  const [addDirection, setAddDirection] = useState<Direction | null>(null)
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null)
  const [editor, setEditor] = useState(() => localStorage.getItem(LAST_EDITOR_KEY) ?? '')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(() => {
    setError(null)
    api.lineageLinks(connId).then(setEdges).catch(e => setError((e as Error).message))
  }, [connId])

  useEffect(() => { refresh() }, [refresh])

  const goTo = (node: LineageNode) => {
    navigate(`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(node.bucket)}/${encPath(node.path)}`)
  }

  const handleUnlink = async (edgeId: number) => {
    try {
      await api.removeLineageLink(connId, edgeId)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const confirmAdd = async () => {
    if (!pendingAdd) return
    setSaving(true)
    setError(null)
    try {
      const parent = pendingAdd.direction === 'parent' ? pendingAdd.node : center
      const child = pendingAdd.direction === 'parent' ? center : pendingAdd.node
      await api.addLineageLink(connId, parent, child, editor)
      localStorage.setItem(LAST_EDITOR_KEY, editor)
      setPendingAdd(null)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // スコープごとに「描くエッジ」を決める。ノードはエッジの端点から起こす
  // (どのスコープでも「線で繋がっているものを描く」で統一できる)。
  const flow = useMemo((): { nodes: LineageNode[]; edges: FlowEdge[] } | null => {
    if (!edges) return null

    let picked: FlowEdge[]
    if (scope === 'bucket') {
      // バケット単位は複数リンクが 1 本に畳まれる。解除は束ねた id すべてに効く。
      const byPair = new Map<string, FlowEdge>()
      for (const e of edges) {
        if (e.parentBucket === e.childBucket) continue
        const key = `${e.parentBucket}>${e.childBucket}`
        const hit = byPair.get(key)
        if (hit) hit.ids.push(e.id)
        else byPair.set(key, {
          ids: [e.id],
          parent: { bucket: e.parentBucket, path: '' },
          child: { bucket: e.childBucket, path: '' },
        })
      }
      picked = [...byPair.values()]
      // collapseToBuckets と同じ結果になることを前提にした畳み込み。
      void collapseToBuckets
    } else if (scope === 'current') {
      // 現在地から辿れる範囲だけ。世代配列はノード集合を得るために使う。
      const reachable = new Set<string>([nodeKey(center)])
      for (const gen of [...ancestorGenerations(edges, center), ...descendantGenerations(edges, center)]) {
        for (const n of gen) reachable.add(nodeKey(n))
      }
      picked = edges
        .filter(e =>
          reachable.has(nodeKey({ bucket: e.parentBucket, path: e.parentPath })) &&
          reachable.has(nodeKey({ bucket: e.childBucket, path: e.childPath })))
        .map(e => ({
          ids: [e.id],
          parent: { bucket: e.parentBucket, path: e.parentPath },
          child: { bucket: e.childBucket, path: e.childPath },
        }))
    } else {
      picked = edges.map(e => ({
        ids: [e.id],
        parent: { bucket: e.parentBucket, path: e.parentPath },
        child: { bucket: e.childBucket, path: e.childPath },
      }))
    }

    const nodeMap = new Map<string, LineageNode>()
    for (const e of picked) {
      nodeMap.set(nodeKey(e.parent), e.parent)
      nodeMap.set(nodeKey(e.child), e.child)
    }
    // 現在地は線が 1 本も無くても必ず描く (「ここが今いる場所」を示すため)。
    if (scope === 'current') nodeMap.set(nodeKey(center), center)

    return { nodes: [...nodeMap.values()], edges: picked }
  }, [edges, scope, center])

  // グラフ上でドラッグして繋いだとき。ピッカー経由の追加と違い編集者名を
  // 都度聞かないので、保存済みの名前をそのまま使う (未設定なら入力を促す)。
  const connectByDrag = useCallback(async (parent: LineageNode, child: LineageNode) => {
    if (!editor) {
      setError('先に「＋ 親を追加」から編集者名を登録してください。')
      return
    }
    setError(null)
    try {
      await api.addLineageLink(connId, parent, child, editor)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [connId, editor, refresh])

  const unlinkMany = useCallback(async (ids: number[]) => {
    setError(null)
    try {
      for (const id of ids) await api.removeLineageLink(connId, id)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [connId, refresh])

  return (
    <section className="lineage-view">
      <div className="lineage-view__toolbar">
        <div className="lineage-view__scopes" role="tablist" aria-label="表示スコープ">
          {(Object.keys(SCOPE_LABEL) as Scope[]).map(s => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              className="lineage-view__scope-btn"
              data-active={scope === s || undefined}
              onClick={() => setScope(s)}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="lineage-view__add-actions">
          <button type="button" onClick={() => setAddDirection('parent')}>＋ 親を追加</button>
          <button type="button" onClick={() => setAddDirection('child')}>＋ 子を追加</button>
        </div>
      </div>

      {error && <p className="filelist__error" role="alert">{error}</p>}
      {!flow ? (
        <p className="lineage-canvas__empty">読み込み中…</p>
      ) : flow.edges.length === 0 && flow.nodes.length <= 1 ? (
        <p className="lineage-canvas__empty">
          登録されたリンクがありません。「＋ 親を追加」/「＋ 子を追加」から繋いでください。
        </p>
      ) : (
        <Suspense fallback={<p className="lineage-canvas__empty">読み込み中…</p>}>
          <LineageFlowCanvas
            nodes={flow.nodes}
            edges={flow.edges}
            center={scope === 'current' ? center : null}
            onNodeClick={setPopupNode}
            onNodeDoubleClick={goTo}
            onEdgeClick={ids => { void unlinkMany(ids) }}
            onConnect={(p, c) => { void connectByDrag(p, c) }}
            onRejectCycle={() => setError('このリンクを追加すると循環します。')}
            isCycle={(p, c) => wouldCreateCycle(edges ?? [], p, c)}
          />
        </Suspense>
      )}

      {popupNode && edges && (
        <LineageNodePopup
          connId={connId}
          node={popupNode}
          edges={edges}
          onNavigate={goTo}
          onUnlink={id => { void handleUnlink(id) }}
          onClose={() => setPopupNode(null)}
        />
      )}

      {addDirection && (
        <LineageLinkPicker
          connId={connId}
          initialBucket={bucket}
          initialPrefix={prefix}
          exclude={center}
          onCancel={() => setAddDirection(null)}
          onSelect={node => { setPendingAdd({ direction: addDirection, node }); setAddDirection(null) }}
        />
      )}

      {pendingAdd && (
        <div className="modal-backdrop" role="presentation">
          <button
            type="button"
            className="modal-backdrop__close-overlay"
            onClick={() => setPendingAdd(null)}
            aria-label="モーダルを閉じる"
            tabIndex={-1}
          />
          <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="lineage-add-title">
            <h3 id="lineage-add-title" className="lineage-add__title">
              {pendingAdd.direction === 'parent' ? 'この親を追加' : 'この子を追加'}
            </h3>
            <p className="lineage-add__target">
              {pendingAdd.node.bucket}/{pendingAdd.node.path}
            </p>
            <label className="lineage-add__editor">
              <span className="label">編集者名</span>
              <input
                value={editor}
                onChange={e => setEditor(e.target.value)}
                placeholder="e.g. tanaka"
                autoComplete="nickname"
                aria-label="編集者名"
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingAdd(null)} disabled={saving}>キャンセル</button>
              <button type="button" onClick={() => void confirmAdd()} disabled={saving || !editor}>
                {saving ? '保存中…' : 'リンクを追加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
