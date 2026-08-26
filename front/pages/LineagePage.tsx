import { useCallback, useEffect, useReducer, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api/client'
import type {
  DatasetDetail, DatasetVersionDetail, LineageGraph as LineageGraphDto, LineageNodeSummary,
  LineageProjection, LineageRunDetail,
} from '../lib/api/types'
import { parseLineageRoute, patchLineageRoute } from '../lib/lineage/route'
import { LineageGraph } from '../components/lineage/LineageGraph'
import { LineageToolbar } from '../components/lineage/LineageToolbar'
import { LineageDetailPanel, type LineageDetail } from '../components/lineage/LineageDetailPanel'
import { LineageCatalog } from '../components/lineage/LineageCatalog'
import { useAuth } from '../lib/auth-context'

interface GraphState {
  loading: boolean
  data: LineageGraphDto | null
  error: string | null
}

type GraphAction =
  | { type: 'idle' }
  | { type: 'start' }
  | { type: 'ok'; data: LineageGraphDto }
  | { type: 'error'; error: string }

function graphReducer(_: GraphState, action: GraphAction): GraphState {
  switch (action.type) {
    case 'idle': return { loading: false, data: null, error: null }
    case 'start': return { loading: true, data: null, error: null }
    case 'ok': return { loading: false, data: action.data, error: null }
    case 'error': return { loading: false, data: null, error: action.error }
  }
}

interface DetailState {
  nodeId: string
  data: LineageDetail | null
  error: string | null
}

const initialGraph: GraphState = { loading: false, data: null, error: null }
const initialDetail: DetailState = { nodeId: '', data: null, error: null }

function detailRequest(node: LineageNodeSummary): Promise<DatasetDetail | DatasetVersionDetail | LineageRunDetail> | null {
  if ((node.kind === 'dataset' || node.kind === 'source') && node.registry?.datasetId) {
    return api.lineageDataset(node.registry.datasetId)
  }
  if (node.kind === 'version') return api.lineageVersion(node.id)
  if (node.kind === 'run') return api.lineageRun(node.id)
  if (node.kind === 'job' && node.latestRun?.id) return api.lineageRun(node.latestRun.id)
  return null
}

function hasDetailRequest(node: LineageNodeSummary): boolean {
  return ((node.kind === 'dataset' || node.kind === 'source') && !!node.registry?.datasetId)
    || node.kind === 'version'
    || node.kind === 'run'
    || (node.kind === 'job' && !!node.latestRun?.id)
}

export default function LineagePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const route = parseLineageRoute(searchParams)
  const [graphState, dispatchGraph] = useReducer(graphReducer, initialGraph)
  const [detailState, setDetailState] = useState<DetailState>(initialDetail)
  const [refreshToken, setRefreshToken] = useState(0)
  const { user } = useAuth()
  const canCurate = user?.permissions.includes('lineage:curate') ?? false

  const ready = route.mode === 'logical'
    ? route.namespace !== '' && route.name !== ''
    : route.versionId !== ''

  useEffect(() => {
    let current = true
    if (!ready) {
      dispatchGraph({ type: 'idle' })
      return () => { current = false }
    }
    dispatchGraph({ type: 'start' })
    api.lineageGraph({
      mode: route.mode,
      rootKind: route.mode === 'logical' ? route.rootKind : undefined,
      namespace: route.mode === 'logical' ? route.namespace : undefined,
      name: route.mode === 'logical' ? route.name : undefined,
      versionId: route.mode === 'versions' ? route.versionId : undefined,
      depth: route.depth,
    }).then(
      data => { if (current) dispatchGraph({ type: 'ok', data }) },
      (error: Error) => { if (current) dispatchGraph({ type: 'error', error: error.message }) },
    )
    return () => { current = false }
  }, [ready, route.mode, route.rootKind, route.namespace, route.name, route.versionId, route.depth, refreshToken])

  const selectedNode = graphState.data?.nodes.find(node => node.id === route.selectedId) ?? null

  useEffect(() => {
    let current = true
    if (!selectedNode) return () => { current = false }
    const request = detailRequest(selectedNode)
    if (!request) return () => { current = false }
    request.then(
      data => { if (current) setDetailState({ nodeId: selectedNode.id, data, error: null }) },
      (error: Error) => { if (current) setDetailState({ nodeId: selectedNode.id, data: null, error: error.message }) },
    )
    return () => { current = false }
  }, [selectedNode])

  const patchRoute = useCallback((patch: Parameters<typeof patchLineageRoute>[1], replace = false) => {
    setSearchParams(current => patchLineageRoute(current, patch), { replace })
  }, [setSearchParams])

  const changeMode = (mode: LineageProjection) => {
    if (mode === route.mode) return
    if (mode === 'versions') {
      // Registry が明示する currentVersionId のみ使う。名前から latest を推測しない。
      const explicitVersion = selectedNode?.registry?.currentVersionId ?? route.versionId
      patchRoute({ mode, versionId: explicitVersion ?? '', selectedId: '' })
    } else {
      patchRoute({ mode, selectedId: '' })
    }
  }

  const projection = graphState.data?.projection
  const projectionProblem = projection && projection.state !== 'synced'
  const detailForSelection = selectedNode && detailState.nodeId === selectedNode.id ? detailState : initialDetail
  const detailLoading = !!selectedNode && hasDetailRequest(selectedNode) && detailState.nodeId !== selectedNode.id

  return (
    <section className="lineage-page">
      <header className="page-head">
        <h2>Lineage</h2>
        {canCurate && <Link className="ghost" to="/lineage/register">手動で登録</Link>}
      </header>

      <LineageCatalog
        hasSelection={ready}
        onSelect={dataset => patchRoute({
          mode: 'logical',
          rootKind: 'dataset',
          namespace: dataset.namespace,
          name: dataset.name,
          selectedId: '',
        })}
      />

      <LineageToolbar
        route={route}
        loading={graphState.loading}
        onModeChange={changeMode}
        onApply={input => patchRoute({ ...input, selectedId: '' })}
        onDepthChange={depth => patchRoute({ depth }, true)}
        onRefresh={() => setRefreshToken(token => token + 1)}
      />

      {projectionProblem && (
        <div className="lineage-notice" role="status">
          <strong>Lineage projection: {projection.state}</strong>
          <span>{projection.message ?? `${projection.pendingEvents ?? 0}件のイベントが反映待ちです。`}</span>
        </div>
      )}
      {graphState.data?.truncated && (
        <div className="lineage-notice" role="status">
          グラフの一部のみ表示しています。Depthを変えるか、起点を絞ってください。
        </div>
      )}
      {graphState.data?.warnings.map((warning, index) => (
        <div key={`${warning}:${index}`} className="lineage-notice" role="status">{warning}</div>
      ))}

      {!ready && (
        <div className="empty-state lineage-empty">
          <h3>{route.mode === 'logical' ? '登録一覧からDatasetを選んでください' : 'DatasetVersionを指定してください'}</h3>
          <p>{route.mode === 'logical'
            ? '名前、説明、S3 URIから検索できます。NamespaceとNameは技術IDとして詳細指定に残しています。'
            : 'Datasetノードを選んで「版・Runを表示」へ切り替えるか、Version IDを入力してください。'}</p>
        </div>
      )}
      {graphState.loading && <p className="lineage-loading">グラフを読み込み中…</p>}
      {graphState.error && <p className="error" role="alert">{graphState.error}</p>}
      {graphState.data && graphState.data.nodes.length === 0 && (
        <div className="empty-state lineage-empty"><h3>Lineageがまだありません</h3><p>PipelineからOpenLineageイベントが届くとここに表示されます。</p></div>
      )}

      {graphState.data && graphState.data.nodes.length > 0 && (
        <div className="lineage-workspace">
          <LineageGraph
            graph={graphState.data}
            selectedId={route.selectedId}
            onSelect={node => patchRoute({ selectedId: node.id })}
            onClearSelection={() => patchRoute({ selectedId: '' })}
          />
          <LineageDetailPanel
            node={selectedNode}
            detail={detailForSelection.data}
            loading={detailLoading}
            error={detailForSelection.error}
            onClose={() => patchRoute({ selectedId: '' })}
            onOpenVersion={versionId => patchRoute({ mode: 'versions', versionId, selectedId: '' })}
          />
        </div>
      )}
    </section>
  )
}
