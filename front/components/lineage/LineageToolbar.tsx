import { useRef, type FormEvent } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
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

// グラフの表示の切り替え (表示方法・表示範囲・更新) と、技術 ID での起点の指定。
// 技術 ID の入力欄はツールバーの下に重ねて開き、表示したら閉じる。
export function LineageToolbar({ route, loading, onModeChange, onApply, onDepthChange, onRefresh }: Props) {
  const technicalRef = useRef<HTMLDetailsElement>(null)
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
    if (technicalRef.current) technicalRef.current.open = false
  }

  return (
    <div className="lineage-toolbar">
      <div className="lineage-segmented" role="group" aria-label="DataLineageの表示方法">
        <button
          type="button"
          aria-pressed={route.mode === 'logical'}
          onClick={() => onModeChange('logical')}
        >
          データセット全体
        </button>
        <button
          type="button"
          aria-pressed={route.mode === 'versions'}
          onClick={() => onModeChange('versions')}
        >
          入出力と処理履歴
        </button>
      </div>

      <label className="lineage-toolbar__item">
        <span>表示範囲</span>
        <select value={route.depth} onChange={event => onDepthChange(Number(event.target.value))}>
          {[1, 2, 3, 4, 5, 6].map(depth => <option key={depth} value={depth}>{depth}</option>)}
        </select>
      </label>
      <button type="button" className="button small lineage-toolbar__button" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={14} aria-hidden="true" className={loading ? 'spin' : undefined} />
        {loading ? '更新中…' : '更新'}
      </button>

      <details ref={technicalRef} className="lineage-toolbar__menu">
        <summary>
          技術IDで指定
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <form
          key={`${route.mode}|${route.rootKind}|${route.namespace}|${route.name}|${route.versionId}`}
          className="popover lineage-root-form"
          onSubmit={submit}
        >
          {route.mode === 'logical' ? (
            <>
              <label className="field">
                <span>種類</span>
                <select name="rootKind" defaultValue={route.rootKind}>
                  <option value="dataset">データセット</option>
                  <option value="job">処理</option>
                </select>
              </label>
              <label className="field">
                <span>名前空間</span>
                <input name="namespace" className="mono" defaultValue={route.namespace} placeholder="speech" />
              </label>
              <label className="field">
                <span>技術名</span>
                <input name="name" className="mono" defaultValue={route.name} placeholder="callhome-raw" />
              </label>
            </>
          ) : (
            <label className="field">
              <span>バージョンID</span>
              <input name="versionId" className="mono" defaultValue={route.versionId} placeholder="バージョンのUUID" />
            </label>
          )}
          <button type="submit" className="button primary">表示</button>
        </form>
      </details>
    </div>
  )
}
