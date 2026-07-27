import { lazy, Suspense, useCallback, useEffect, useReducer, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { LineageLink } from '../lib/api/types'
import { nodeKey, wouldCreateCycle, type LineageNode } from '../lib/lineageGraph'
import { encPath } from '../lib/route'
import type { FlowEdge } from './storage/lineage/LineageFlowCanvas'
import { ImportExportButtons } from './ImportExportButtons'
import { downloadJson, type ImportSummary } from '../lib/jsonFile'

// エクスポート形式。id / createdAt / createdBy は書き出さない — 取り込み先で
// 採番・記録し直すため。リンクの同一性は 4 つのパスの組で決まる。
interface LineageExport {
  mado: 'lineage'
  version: 1
  links: Array<{
    parentBucket: string; parentPath: string
    childBucket: string; childPath: string
  }>
}

// React Flow は重いので家系図を開いた人だけが払うよう別チャンクにする
// (バケット画面の LineageView と同じ扱い)。
const LineageFlowCanvas = lazy(() => import('./storage/lineage/LineageFlowCanvas'))

interface Props {
  connId: string
}

const LAST_EDITOR_KEY = 'dashboard.lastEditor'

interface State {
  links: LineageLink[] | null
  error: string | null
}

type Action =
  | { type: 'ok'; links: LineageLink[] }
  | { type: 'err'; error: string }

// useState のセッターを useEffect 内で直接呼ぶと react-hooks/set-state-in-effect
// (eslint) に引っかかるため useReducer + dispatch で持つ (既存パターン)。
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'ok':
      return { links: a.links, error: null }
    case 'err':
      return { ...s, error: a.error }
  }
}

// データ家系図 (接続全体)。Storage からリンクで開く独立したビュー。
//
// バケット画面の家系図は「現在地」を中心に据えるが、こちらは中心を持たず
// 接続内の全リンクをそのまま 1 枚のグラフにする。描画はバケット画面と同じ
// LineageFlowCanvas を使うので、操作 (パン / ズーム / ドラッグ接続 /
// エッジクリックで解除) も揃う。
export function LineageListView({ connId }: Props) {
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, { links: null, error: null })
  const { links, error } = state
  const [editor, setEditor] = useState(() => localStorage.getItem(LAST_EDITOR_KEY) ?? '')
  const [saving, setSaving] = useState(false)
  const [pendingConnect, setPendingConnect] = useState<{ parent: LineageNode; child: LineageNode } | null>(null)
  const [pendingUnlink, setPendingUnlink] = useState<number[] | null>(null)
  const [opError, setOpError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.lineageLinks(connId)
      .then(r => dispatch({ type: 'ok', links: r }))
      .catch((e: Error) => dispatch({ type: 'err', error: e.message }))
  }, [connId])

  useEffect(() => { refresh() }, [refresh])

  const goTo = useCallback((n: LineageNode) => {
    navigate(`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(n.bucket)}/${encPath(n.path)}`)
  }, [connId, navigate])

  const saveLink = useCallback(async (parent: LineageNode, child: LineageNode, who: string) => {
    setSaving(true)
    setOpError(null)
    try {
      await api.addLineageLink(connId, parent, child, who)
      localStorage.setItem(LAST_EDITOR_KEY, who)
      setPendingConnect(null)
      refresh()
    } catch (e) {
      setOpError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [connId, refresh])

  // 名前が保存済みならそのまま確定し、未登録のときだけ聞く。
  const connectByDrag = useCallback((parent: LineageNode, child: LineageNode) => {
    if (!editor) {
      setPendingConnect({ parent, child })
      return
    }
    void saveLink(parent, child, editor)
  }, [editor, saveLink])

  const unlinkMany = useCallback(async (ids: number[]) => {
    setOpError(null)
    try {
      for (const id of ids) await api.removeLineageLink(connId, id)
      setPendingUnlink(null)
      refresh()
    } catch (e) {
      setOpError((e as Error).message)
    }
  }, [connId, refresh])

  const handleExport = () => {
    const body: LineageExport = {
      mado: 'lineage',
      version: 1,
      links: (links ?? []).map(l => ({
        parentBucket: l.parentBucket, parentPath: l.parentPath,
        childBucket: l.childBucket, childPath: l.childPath,
      })),
    }
    downloadJson('mado-lineage.json', body)
  }

  // 既存と同じ組はスキップする。POST 自体は冪等 (ON CONFLICT DO UPDATE) だが、
  // 「何件が新規だったか」を出したいのでこちら側でも見る。
  // 閉路になる組はサーバが 409 を返すので失敗として数える。
  const handleImport = async (data: unknown): Promise<ImportSummary> => {
    const d = data as Partial<LineageExport>
    if (d?.mado !== 'lineage' || !Array.isArray(d.links)) {
      throw new Error('mado の家系図のエクスポートファイルではありません。')
    }
    const key = (l: { parentBucket: string; parentPath: string; childBucket: string; childPath: string }) =>
      `${l.parentBucket}|${l.parentPath}>${l.childBucket}|${l.childPath}`
    const existing = new Set((links ?? []).map(key))
    const who = editor || 'import'
    const summary: ImportSummary = { added: 0, skipped: 0, failed: [] }
    for (const l of d.links) {
      if (typeof l?.parentBucket !== 'string' || typeof l?.childBucket !== 'string'
        || typeof l?.parentPath !== 'string' || typeof l?.childPath !== 'string') {
        summary.failed.push('パスが文字列でない項目があります')
        continue
      }
      if (existing.has(key(l))) { summary.skipped++; continue }
      try {
        await api.addLineageLink(
          connId,
          { bucket: l.parentBucket, path: l.parentPath },
          { bucket: l.childBucket, path: l.childPath },
          who,
        )
        existing.add(key(l))
        summary.added++
      } catch (e) {
        summary.failed.push(`${l.parentBucket}/${l.parentPath} → ${l.childBucket}/${l.childPath}: ${(e as Error).message}`)
      }
    }
    return summary
  }

  const flowEdges: FlowEdge[] = (links ?? []).map(l => ({
    ids: [l.id],
    parent: { bucket: l.parentBucket, path: l.parentPath },
    child: { bucket: l.childBucket, path: l.childPath },
  }))
  const nodeMap = new Map<string, LineageNode>()
  for (const e of flowEdges) {
    nodeMap.set(nodeKey(e.parent), e.parent)
    nodeMap.set(nodeKey(e.child), e.child)
  }
  const flowNodes = [...nodeMap.values()]

  return (
    <section>
      {error && <p className="error mt-2">{error}</p>}
      {opError && <p className="error mt-2" role="alert">{opError}</p>}

      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        {links !== null && (
          <p className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
            {links.length} 件
          </p>
        )}
        <ImportExportButtons onExport={handleExport} onImport={handleImport} onDone={refresh} />
      </div>

      {links !== null && links.length === 0 && !error && (
        <p className="mt-3 text-[13px] text-ink-7">
          リンクがまだありません。バケットの家系図タブから繋いでください。
        </p>
      )}

      {links !== null && links.length > 0 && (
        <div className="mt-2">
          <Suspense fallback={<p className="lineage-canvas__empty">読み込み中…</p>}>
            <LineageFlowCanvas
              nodes={flowNodes}
              edges={flowEdges}
              center={null}
              /* 接続全体では中心が無く、親子の詳細はバケット画面側で見るので
                 シングルクリックのポップアップは持たない。 */
              onNodeClick={() => {}}
              onNodeDoubleClick={goTo}
              onEdgeClick={setPendingUnlink}
              onConnect={connectByDrag}
              onRejectCycle={() => setOpError('このリンクを追加すると循環します。')}
              isCycle={(p, c) => wouldCreateCycle(links, p, c)}
            />
          </Suspense>
          <p className="mt-2 text-[12px] text-ink-7">
            ノードをダブルクリックでその場所へ移動。ノード右端の ○ からドラッグでリンク追加、
            エッジをクリックで解除。
          </p>
        </div>
      )}

      {pendingConnect && (
        <div className="modal-backdrop" role="presentation">
          <button
            type="button"
            className="modal-backdrop__close-overlay"
            onClick={() => setPendingConnect(null)}
            aria-label="モーダルを閉じる"
            tabIndex={-1}
          />
          <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="lineage-all-connect-title">
            <h3 id="lineage-all-connect-title" className="lineage-add__title">リンクを追加</h3>
            <p className="lineage-add__target">
              {pendingConnect.parent.bucket}/{pendingConnect.parent.path}
              {' → '}
              {pendingConnect.child.bucket}/{pendingConnect.child.path}
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
              <button type="button" onClick={() => setPendingConnect(null)} disabled={saving}>キャンセル</button>
              <button
                type="button"
                disabled={saving || !editor}
                onClick={() => void saveLink(pendingConnect.parent, pendingConnect.child, editor)}
              >
                {saving ? '保存中…' : 'リンクを追加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingUnlink && (
        <div className="modal-backdrop" role="presentation">
          <button
            type="button"
            className="modal-backdrop__close-overlay"
            onClick={() => setPendingUnlink(null)}
            aria-label="モーダルを閉じる"
            tabIndex={-1}
          />
          <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="lineage-all-unlink-title">
            <h3 id="lineage-all-unlink-title" className="lineage-add__title">リンクを解除</h3>
            <p className="lineage-add__target">このリンクを解除します。</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingUnlink(null)}>キャンセル</button>
              <button type="button" onClick={() => void unlinkMany(pendingUnlink)}>解除</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
