import type { FormEvent } from 'react'
import type { LineageProjection } from '../../lib/api/types'
import type { LineageRouteState } from '../../lib/lineage/route'

interface RootInput {
  rootKind: 'dataset' | 'job'
  namespace: string
  name: string
  versionId: string
}

interface Props {
  route: LineageRouteState
  loading: boolean
  onModeChange: (mode: LineageProjection) => void
  onApply: (input: RootInput) => void
  onDepthChange: (depth: number) => void
  onRefresh: () => void
}

export function LineageToolbar({ route, loading, onModeChange, onApply, onDepthChange, onRefresh }: Props) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    onApply({
      rootKind: route.mode === 'logical'
        ? (data.get('rootKind') === 'job' ? 'job' : 'dataset')
        : route.rootKind,
      namespace: route.mode === 'logical' ? String(data.get('namespace') ?? '') : route.namespace,
      name: route.mode === 'logical' ? String(data.get('name') ?? '') : route.name,
      versionId: String(data.get('versionId') ?? ''),
    })
  }

  return (
    <div className="lineage-toolbar">
      <div className="lineage-toolbar__modes" role="group" aria-label="DataLineageの表示方法">
        <button
          type="button"
          className="lineage-toolbar__mode"
          data-active={route.mode === 'logical' || undefined}
          aria-pressed={route.mode === 'logical'}
          onClick={() => onModeChange('logical')}
        >
          データセット全体
        </button>
        <button
          type="button"
          className="lineage-toolbar__mode"
          data-active={route.mode === 'versions' || undefined}
          aria-pressed={route.mode === 'versions'}
          onClick={() => onModeChange('versions')}
        >
          入出力と処理履歴
        </button>
      </div>

      <label className="lineage-toolbar__depth">
        <span>表示範囲</span>
        <select value={route.depth} onChange={event => onDepthChange(Number(event.target.value))}>
          {[1, 2, 3, 4, 5, 6].map(depth => <option key={depth} value={depth}>{depth}</option>)}
        </select>
      </label>
      <button type="button" className="ghost" onClick={onRefresh} disabled={loading}>
        {loading ? '更新中…' : '↻ 更新'}
      </button>

      <details className="lineage-toolbar__technical">
        <summary>技術IDで指定</summary>
        <form
          key={`${route.mode}|${route.rootKind}|${route.namespace}|${route.name}|${route.versionId}`}
          className="lineage-toolbar__root"
          onSubmit={submit}
        >
          {route.mode === 'logical' ? (
            <>
              <label>
                <span>種類</span>
                <select name="rootKind" defaultValue={route.rootKind}>
                  <option value="dataset">データセット</option>
                  <option value="job">処理</option>
                </select>
              </label>
              <label>
                <span>名前空間</span>
                <input name="namespace" defaultValue={route.namespace} placeholder="speech" />
              </label>
              <label className="lineage-toolbar__name">
                <span>技術名</span>
                <input name="name" defaultValue={route.name} placeholder="callhome-raw" />
              </label>
            </>
          ) : (
            <label className="lineage-toolbar__name">
              <span>バージョンID</span>
              <input name="versionId" defaultValue={route.versionId} placeholder="バージョンのUUID" />
            </label>
          )}
          <button type="submit" className="ghost">表示</button>
        </form>
      </details>
    </div>
  )
}
