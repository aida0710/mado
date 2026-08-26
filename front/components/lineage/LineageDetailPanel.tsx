import { Link } from 'react-router-dom'
import type {
  DatasetDetail, DatasetVersionDetail, LineageNodeSummary, LineageRunDetail,
  LineageStorageLocationDetail,
} from '../../lib/api/types'
import { encPath, parseS3Path } from '../../lib/route'

export type LineageDetail = DatasetDetail | DatasetVersionDetail | LineageRunDetail

interface Props {
  node: LineageNodeSummary | null
  detail: LineageDetail | null
  loading: boolean
  error: string | null
  onClose: () => void
  onOpenVersion: (versionId: string) => void
}
function formatTime(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP', { hour12: false })
}

function display(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function Field({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="lineage-detail__field">
      <dt>{label}</dt>
      <dd className={mono ? 'font-mono wrap-anywhere' : undefined}>{display(value)}</dd>
    </div>
  )
}

function storagePath(location: LineageStorageLocationDetail): string | null {
  if (!location.madoConnectionId) return null
  const parsed = parseS3Path(location.uri)
  const bucket = location.bucket ?? parsed?.bucket
  if (!bucket) return null
  const path = parsed?.prefix ?? ''
  return `/storage/${encodeURIComponent(location.madoConnectionId)}/${encodeURIComponent(bucket)}/${encPath(path)}`
}

function Location({ location }: { location: LineageStorageLocationDetail }) {
  const to = storagePath(location)
  return (
    <li className="lineage-location">
      <div className="flex items-center justify-between gap-2">
        <strong>{location.storageKind}</strong>
        <span data-status={location.status}>{location.status}</span>
      </div>
      <p className="font-mono wrap-anywhere">{location.uri}</p>
      <small>{location.isPrimary ? 'Primary · ' : ''}{formatTime(location.observedAt)}</small>
      {to && <Link to={to}>この保存場所をStorageで開く</Link>}
    </li>
  )
}

function VersionDetail({ detail }: { detail: DatasetVersionDetail }) {
  return (
    <>
      <dl className="lineage-detail__fields">
        <Field label="Version" value={detail.version} />
        <Field label="Content hash" value={detail.contentHash} mono />
        <Field label="Manifest" value={detail.manifestUri} mono />
        <Field label="Manifest hash" value={detail.manifestHash} mono />
        <Field label="Schema" value={detail.schemaUri} mono />
        <Field label="Created" value={formatTime(detail.createdAt)} />
      </dl>
      <h4>保存場所 <span>{detail.locations.length}</span></h4>
      {detail.locations.length > 0
        ? <ul className="lineage-detail__locations">{detail.locations.map(location => <Location key={location.id} location={location} />)}</ul>
        : <p className="lineage-detail__muted">登録された保存場所はありません。</p>}
    </>
  )
}

function DatasetDetailView({ detail, onOpenVersion }: { detail: DatasetDetail; onOpenVersion: (id: string) => void }) {
  return (
    <>
      <dl className="lineage-detail__fields">
        <Field label="Dataset key" value={detail.datasetKey} mono />
        <Field label="Media type" value={detail.mediaType} />
        <Field label="Owner" value={detail.owner} />
        <Field label="Created" value={formatTime(detail.createdAt)} />
        <Field label="Description" value={detail.description} />
      </dl>
      <h4>Versions <span>{detail.versionCount}</span></h4>
      <ul className="lineage-detail__versions">
        {detail.versions.map(version => (
          <li key={version.id}>
            <button type="button" onClick={() => onOpenVersion(version.id)}>
              <strong>{version.version}</strong>
              <span>{formatTime(version.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function RunDetail({ detail }: { detail: LineageRunDetail }) {
  return (
    <>
      <dl className="lineage-detail__fields">
        <Field label="Status" value={detail.status} />
        <Field label="Job" value={`${detail.jobNamespace} / ${detail.jobName}`} mono />
        <Field label="Started" value={formatTime(detail.startedAt)} />
        <Field label="Ended" value={formatTime(detail.endedAt)} />
        <Field label="Git SHA" value={detail.gitSha} mono />
        <Field label="Container digest" value={detail.containerDigest} mono />
        <Field label="Config URI" value={detail.configUri} mono />
        <Field label="Config hash" value={detail.configHash} mono />
        <Field label="Models" value={detail.modelRefs.length > 0 ? detail.modelRefs : null} mono />
        <Field label="Metrics" value={Object.keys(detail.metrics).length > 0 ? detail.metrics : null} mono />
        <Field label="Error" value={detail.errorMessage} />
      </dl>
      <h4>Inputs / Outputs</h4>
      <ul className="lineage-detail__io">
        {detail.inputs.map(input => <li key={`in:${input.versionId}`}><span>IN</span>{input.namespace} / {input.name} @ {input.version}</li>)}
        {detail.outputs.map(output => <li key={`out:${output.versionId}`}><span>OUT</span>{output.namespace} / {output.name} @ {output.version}</li>)}
      </ul>
    </>
  )
}

function isRun(detail: LineageDetail): detail is LineageRunDetail { return 'runKey' in detail }
function isDataset(detail: LineageDetail): detail is DatasetDetail { return 'datasetKey' in detail }

export function LineageDetailPanel({ node, detail, loading, error, onClose, onOpenVersion }: Props) {
  return (
    <aside className="lineage-detail" aria-label="Lineage node detail">
      <header>
        <div>
          <span>{node?.kind ?? 'Detail'}</span>
          <h3>{node?.label ?? 'ノードを選択'}</h3>
          {node?.namespace && <p>{node.namespace}</p>}
        </div>
        {node && <button type="button" className="ghost" onClick={onClose} aria-label="詳細を閉じる">✕</button>}
      </header>

      {!node && <p className="lineage-detail__muted">グラフのノードを選ぶと、版・保存場所・実行条件を表示します。</p>}
      {loading && <p className="lineage-detail__muted">詳細を読み込み中…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {node && !loading && !error && !detail && (
        <dl className="lineage-detail__fields">
          <Field label="Status" value={node.status ?? node.latestRun?.state} />
          <Field label="Registry" value={node.completeness} />
          <Field label="Updated" value={formatTime(node.updatedAt)} />
        </dl>
      )}
      {detail && (isRun(detail)
        ? <RunDetail detail={detail} />
        : isDataset(detail)
          ? <DatasetDetailView detail={detail} onOpenVersion={onOpenVersion} />
          : <VersionDetail detail={detail} />)}
    </aside>
  )
}
