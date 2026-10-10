import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen, Pencil, X } from 'lucide-react'
import type {
  DatasetDetail, DatasetVersionDetail, LineageNodeSummary, LineageRunDetail,
  LineageStorageLocationDetail, LineageDatasetUpdateInput,
} from '../../lib/api/types'
import {
  LINEAGE_KIND_LABEL, lineageCompletenessLabel, lineageSourceKindLabel, lineageStatusLabel,
  lineageStatusTone,
} from '../../lib/lineage/labels'
import { encPath, parseS3Path } from '../../lib/route'

export type LineageDetail = DatasetDetail | DatasetVersionDetail | LineageRunDetail

interface Props {
  node: LineageNodeSummary | null
  detail: LineageDetail | null
  loading: boolean
  error: string | null
  onClose: () => void
  onOpenVersion: (versionId: string) => void
  canEdit?: boolean
  onUpdateDataset?: (datasetId: string, input: LineageDatasetUpdateInput) => Promise<DatasetDetail>
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

function displayJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function isEmptyStructuredValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0
}

function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const label = lineageStatusLabel(status)
  if (!label) return null
  return <span className={`status-badge status-${lineageStatusTone(status) ?? 'queued'}`}>{label}</span>
}

// .details-list の 1 行。JSON は行の幅いっぱいに .json-view で出す。
function Field({
  label,
  value,
  mono = false,
  json = false,
}: {
  label: string
  value: unknown
  mono?: boolean
  json?: boolean
}) {
  if (value === null || value === undefined || value === '') return null
  if (json && isEmptyStructuredValue(value)) return null
  return (
    <div className={json ? 'lineage-detail__json-field' : undefined}>
      <dt>{label}</dt>
      <dd className={mono ? 'mono break-word' : undefined}>
        {json
          ? <pre className="json-view" aria-label={`${label} JSON`}><code>{displayJson(value)}</code></pre>
          : display(value)}
      </dd>
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
      <div className="lineage-location__head">
        <strong>{location.storageKind}</strong>
        <StatusBadge status={location.status} />
      </div>
      <p className="mono break-word">{location.uri}</p>
      <p className="muted">{location.isPrimary ? '主な保存場所 · ' : ''}{formatTime(location.observedAt)}</p>
      {to && (
        <Link className="lineage-location__open" to={to}>
          <FolderOpen size={14} aria-hidden="true" />
          この保存場所をStorageで開く
        </Link>
      )}
    </li>
  )
}

function VersionDetail({ detail }: { detail: DatasetVersionDetail }) {
  return (
    <>
      <dl className="details-list">
        <Field label="バージョン" value={detail.version} />
        <Field label="内容のハッシュ" value={detail.contentHash} mono />
        <Field label="ファイル一覧URI" value={detail.manifestUri} mono />
        <Field label="ファイル一覧のハッシュ" value={detail.manifestHash} mono />
        <Field label="スキーマURI" value={detail.schemaUri} mono />
        <Field label="処理時期" value={metadataText(detail.metadata, 'documentedProcessDate')} />
        <Field label="登録日時" value={formatTime(detail.createdAt)} />
        <Field label="補足情報" value={detail.metadata} json />
      </dl>
      <h3>保存場所 <span className="muted">{detail.locations.length}</span></h3>
      {detail.locations.length > 0
        ? <ul className="lineage-location-list">{detail.locations.map(location => <Location key={location.id} location={location} />)}</ul>
        : <p className="muted">登録された保存場所はありません。</p>}
    </>
  )
}

function optionalText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function DatasetEditForm({
  detail, onCancel, onSave,
}: {
  detail: DatasetDetail
  onCancel: () => void
  onSave: (input: LineageDatasetUpdateInput) => Promise<void>
}) {
  const [displayName, setDisplayName] = useState(detail.displayName ?? '')
  const [aliases, setAliases] = useState(detail.aliases.join('\n'))
  const [description, setDescription] = useState(detail.description ?? '')
  const [mediaType, setMediaType] = useState(detail.mediaType ?? '')
  const [owner, setOwner] = useState(detail.owner ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave({
        displayName: optionalText(displayName),
        aliases: [...new Set(aliases.split(/[\n,]/).map(value => value.trim()).filter(Boolean))],
        description: optionalText(description),
        mediaType: optionalText(mediaType),
        owner: optionalText(owner),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="lineage-detail__edit" onSubmit={event => void submit(event)}>
      <label className="field"><span>表示名</span><input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={512} /></label>
      <label className="field"><span>別名（改行またはカンマ区切り）</span><textarea value={aliases} onChange={event => setAliases(event.target.value)} /></label>
      <label className="field"><span>データ形式</span><input value={mediaType} onChange={event => setMediaType(event.target.value)} maxLength={512} /></label>
      <label className="field"><span>管理者</span><input value={owner} onChange={event => setOwner(event.target.value)} maxLength={512} /></label>
      <label className="field"><span>説明</span><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={8192} /></label>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="lineage-detail__edit-actions">
        <button type="button" className="button" onClick={onCancel} disabled={saving}>キャンセル</button>
        <button type="submit" className="button primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </form>
  )
}

function DatasetDetailView({
  detail, onOpenVersion, canEdit, onUpdate,
}: {
  detail: DatasetDetail
  onOpenVersion: (id: string) => void
  canEdit: boolean
  onUpdate?: (datasetId: string, input: LineageDatasetUpdateInput) => Promise<DatasetDetail>
}) {
  const [editing, setEditing] = useState(false)

  if (editing && detail.datasetId && onUpdate) {
    return <DatasetEditForm detail={detail} onCancel={() => setEditing(false)} onSave={async input => {
      await onUpdate(detail.datasetId!, input)
      setEditing(false)
    }} />
  }
  return (
    <>
      {canEdit && detail.datasetId && onUpdate && (
        <div className="lineage-detail__actions">
          <button type="button" className="button small" onClick={() => setEditing(true)}>
            <Pencil size={14} aria-hidden="true" />
            説明情報を編集
          </button>
        </div>
      )}
      <dl className="details-list">
        <Field label="表示名" value={detail.displayName} />
        <Field label="データセットキー" value={detail.datasetKey} mono />
        <Field label="別名" value={detail.aliases.join(' / ')} />
        <Field label="データ形式" value={detail.mediaType} />
        <Field label="管理者" value={detail.owner} />
        <Field label="登録日時" value={formatTime(detail.createdAt)} />
        <Field label="説明" value={detail.description} />
      </dl>
      <h3>バージョン <span className="muted">{detail.versionCount}</span></h3>
      {detail.versions.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">バージョン</th>
                <th scope="col">処理時期</th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map(version => (
                <tr key={version.id}>
                  <td>
                    <button type="button" className="link-button mono break-word" onClick={() => onOpenVersion(version.id)}>
                      {version.version}
                    </button>
                  </td>
                  <td>{metadataText(version.metadata, 'documentedProcessDate') ?? <span className="muted">処理時期不明</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function RunDetail({ detail }: { detail: LineageRunDetail }) {
  const historicalTimeUnknown = detail.runtime.recordKind === 'historical-lineage-assertion'
    && detail.runtime.executionTimeStatus === 'unknown'
  const documentedProcessDate = metadataText(detail.runtime, 'documentedProcessDate')
  const datasets = [
    ...detail.inputs.map(item => ({ ...item, direction: '入力', key: `in:${item.versionId}` })),
    ...detail.outputs.map(item => ({ ...item, direction: '出力', key: `out:${item.versionId}` })),
  ]
  return (
    <>
      <dl className="details-list">
        <div>
          <dt>状態</dt>
          <dd><StatusBadge status={detail.status} /></dd>
        </div>
        <Field label="処理" value={`${detail.jobNamespace} / ${detail.jobName}`} mono />
        <Field label="処理時期" value={documentedProcessDate} />
        {!historicalTimeUnknown && <Field label="開始日時" value={formatTime(detail.startedAt)} />}
        {!historicalTimeUnknown && <Field label="終了日時" value={formatTime(detail.endedAt)} />}
        <Field label="登録日時" value={formatTime(detail.createdAt)} />
        <Field label="Gitコミット" value={detail.gitSha} mono />
        <Field label="コンテナイメージ" value={detail.containerDigest} mono />
        <Field label="設定ファイルURI" value={detail.configUri} mono />
        <Field label="設定ファイルのハッシュ" value={detail.configHash} mono />
        <Field label="使用モデル" value={detail.modelRefs} json />
        <Field label="実行環境" value={detail.runtime} json />
        <Field label="実行結果" value={detail.metrics} json />
        <Field label="入手元" value={detail.sources} json />
        <Field label="エラー" value={detail.errorMessage} />
      </dl>
      <h3>入力 / 出力</h3>
      {datasets.length > 0 && (
        <div className="table-scroll">
          <table>
            <tbody>
              {datasets.map(item => (
                <tr key={item.key}>
                  <th scope="row" className="lineage-detail__io-direction">{item.direction}</th>
                  <td className="mono break-word">{item.namespace} / {item.name} @ {item.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function isRun(detail: LineageDetail): detail is LineageRunDetail { return 'runKey' in detail }
function isDataset(detail: LineageDetail): detail is DatasetDetail { return 'datasetKey' in detail }

function EmbeddedNodeDetail({ node }: { node: LineageNodeSummary }) {
  const source = node.kind === 'source'
  const status = node.status ?? node.latestRun?.state
  return (
    <dl className="details-list">
      {lineageStatusLabel(status) && (
        <div>
          <dt>状態</dt>
          <dd><StatusBadge status={status} /></dd>
        </div>
      )}
      <Field label="台帳登録" value={lineageCompletenessLabel(node.completeness)} />
      <Field label="更新日時" value={formatTime(node.updatedAt)} />
      {source && <Field label="入手方法" value={lineageSourceKindLabel(node.data.sourceKind)} />}
      {source && <Field label="URI" value={node.data.uri} mono />}
      {source && <Field label="提供元" value={node.data.vendor} />}
      {source && <Field label="製品名" value={node.data.product} />}
      {source && <Field label="ライセンス参照" value={node.data.licenseRef} mono />}
      {source && <Field label="契約参照" value={node.data.contractRef} mono />}
      {source && <Field label="補足情報" value={node.data.metadata} json />}
    </dl>
  )
}

/** 選んだ項目の詳細。広い画面ではグラフの右、900px 未満ではグラフの下に置く (lineage.css)。 */
export function LineageDetailPanel({
  node, detail, loading, error, onClose, onOpenVersion, canEdit = false, onUpdateDataset,
}: Props) {
  return (
    <aside className="lineage-detail" aria-label="選択項目の詳細">
      <header className="lineage-detail__header">
        <div>
          <span className="lineage-kind" data-kind={node?.kind}>{node ? LINEAGE_KIND_LABEL[node.kind] : '詳細'}</span>
          <h2>{node?.label ?? '項目を選択'}</h2>
          {node?.namespace && <p className="muted mono break-word">{node.namespace}</p>}
        </div>
        {node && (
          <button type="button" className="icon-button" onClick={onClose} aria-label="詳細を閉じる" title="詳細を閉じる">
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </header>

      {!node && <p className="muted">グラフの項目を選ぶと、バージョン、保存場所、実行条件を表示します。</p>}
      {loading && <p className="muted">詳細を読み込み中…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {node && !loading && !error && !detail && (
        <EmbeddedNodeDetail node={node} />
      )}
      {detail && (isRun(detail)
        ? <RunDetail detail={detail} />
        : isDataset(detail)
          ? <DatasetDetailView detail={detail} onOpenVersion={onOpenVersion} canEdit={canEdit} onUpdate={onUpdateDataset} />
          : <VersionDetail detail={detail} />)}
    </aside>
  )
}
