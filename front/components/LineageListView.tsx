import { lazy, Suspense, useCallback, useEffect, useReducer, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { LineageLink } from '../lib/api/types'
import { nodeKey, wouldCreateCycle, type LineageNode } from '../lib/lineageGraph'
import { encPath, parseS3Path } from '../lib/route'
import type { FlowEdge } from './storage/lineage/LineageFlowCanvas'
import { LineageNodePopup } from './storage/lineage/LineageNodePopup'
import { ImportExportButtons } from './ImportExportButtons'
import { downloadJson, type ImportSummary } from '../lib/jsonFile'

// エクスポート形式。id / createdAt / createdBy は書き出さない — 取り込み先で
// 採番・記録し直すため。リンクの同一性は親子のパスの組で決まる。
//
// v2 でノードを `s3://bucket/key` の 1 本のフルパスにした。v1 は bucket と
// path が別フィールドに割れていて、バケット直下が path:"" になるなど、
// 目で読んで手で直すのがつらかった。アプリ内の「S3 URL をコピー」や
// `s3://bucket/key を貼付` と同じ表記で揃える。
//
// バケット直下は末尾スラッシュ付き (`s3://bucket/`)。ディレクトリも末尾
// スラッシュを保つ。ファイルは付かない — nodeKind() の判定規則がそのまま乗る。
interface LineageExportV2 {
  mado: 'lineage'
  version: 2
  links: Array<{ parent: string; child: string }>
}

// v1 (bucket / path が別フィールド) もインポートは受け付ける — すでに
// 書き出したファイルを読めるようにするため。判定は handleImport 内で行う。

function toS3Uri(n: LineageNode): string {
  return `s3://${n.bucket}/${n.path}`
}

// `s3://bucket/key` を戻す。バケットが取れないものは弾く。
function fromS3Uri(uri: unknown): LineageNode | null {
  if (typeof uri !== 'string') return null
  const parsed = parseS3Path(uri)
  if (!parsed) return null
  return { bucket: parsed.bucket, path: parsed.prefix }
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
  const [popupNode, setPopupNode] = useState<LineageNode | null>(null)
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
    const body: LineageExportV2 = {
      mado: 'lineage',
      version: 2,
      links: (links ?? []).map(l => ({
        parent: toS3Uri({ bucket: l.parentBucket, path: l.parentPath }),
        child: toS3Uri({ bucket: l.childBucket, path: l.childPath }),
      })),
    }
    downloadJson('mado-lineage.json', body)
  }

  // 既存と同じ組はスキップする。POST 自体は冪等 (ON CONFLICT DO UPDATE) だが、
  // 「何件が新規だったか」を出したいのでこちら側でも見る。
  // 閉路になる組はサーバが 409 を返すので失敗として数える。
  const handleImport = async (data: unknown): Promise<ImportSummary> => {
    // v1 と v2 は version が違うので交差型にすると never になる。ここは
    // 形の検証が目的なので緩い型で受けて、下で 1 件ずつ判定する。
    const d = data as { mado?: unknown; links?: unknown } | null
    if (d?.mado !== 'lineage' || !Array.isArray(d.links)) {
      throw new Error('mado の家系図のエクスポートファイルではありません。')
    }
    // v1 / v2 のどちらでも読めるようにここで 1 つの形へ寄せる。
    const pairs: Array<{ parent: LineageNode; child: LineageNode } | null> =
      (d.links as unknown[]).map(raw => {
        const l = raw as Record<string, unknown>
        if (typeof l?.parent === 'string' || typeof l?.child === 'string') {
          const parent = fromS3Uri(l.parent)
          const child = fromS3Uri(l.child)
          return parent && child ? { parent, child } : null
        }
        if (typeof l?.parentBucket === 'string' && typeof l?.childBucket === 'string'
          && typeof l?.parentPath === 'string' && typeof l?.childPath === 'string') {
          return {
            parent: { bucket: l.parentBucket, path: l.parentPath },
            child: { bucket: l.childBucket, path: l.childPath },
          }
        }
        return null
      })

    const key = (n: { parent: LineageNode; child: LineageNode }) =>
      `${nodeKey(n.parent)}>${nodeKey(n.child)}`
    const existing = new Set((links ?? []).map(l => key({
      parent: { bucket: l.parentBucket, path: l.parentPath },
      child: { bucket: l.childBucket, path: l.childPath },
    })))
    const who = editor || 'import'
    const summary: ImportSummary = { added: 0, skipped: 0, failed: [] }
    for (const pair of pairs) {
      if (!pair) {
        summary.failed.push('パスとして読めない項目があります')
        continue
      }
      if (existing.has(key(pair))) { summary.skipped++; continue }
      try {
        await api.addLineageLink(connId, pair.parent, pair.child, who)
        existing.add(key(pair))
        summary.added++
      } catch (e) {
        summary.failed.push(`${toS3Uri(pair.parent)} → ${toS3Uri(pair.child)}: ${(e as Error).message}`)
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
        <ImportExportButtons what="家系図" onExport={handleExport} onImport={handleImport} onDone={refresh} />
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
              onNodeClick={setPopupNode}
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

      {popupNode && links && (
        <LineageNodePopup
          connId={connId}
          node={popupNode}
          edges={links}
          onNavigate={goTo}
          onUnlink={id => { void unlinkMany([id]) }}
          onClose={() => setPopupNode(null)}
        />
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
