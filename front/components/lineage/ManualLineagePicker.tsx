import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { api } from '../../lib/api/client'
import type { RegistryDatasetSummary } from '../../lib/api/types'
import { isFromRowControl } from '../../lib/rowClick'

export interface VersionChoice {
  id: string
  datasetId: string
  datasetLabel: string
  namespace: string
  name: string
  version: string
}

// 選び終えた項目。ラベルの下に名前と技術名を出し、「変更」で選び直す。
function PickedValue({ label, title, identity, onChange }: {
  label: string
  title: string
  identity: string
  onChange: () => void
}) {
  return (
    <div className="field lineage-picker">
      <span>{label}</span>
      <div className="lineage-picked">
        <div>
          <strong>{title}</strong>
          <span className="muted mono break-word">{identity}</span>
        </div>
        <button type="button" className="button small" onClick={onChange}>変更</button>
      </div>
    </div>
  )
}

interface DatasetPickerProps {
  value: RegistryDatasetSummary | null
  onChange: (value: RegistryDatasetSummary | null) => void
  label?: string
}

export function DatasetPicker({ value, onChange, label = 'データセット' }: DatasetPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistryDatasetSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (value || query.trim().length === 0) return
    let current = true
    const timer = window.setTimeout(() => {
      api.lineageCatalog({ q: query.trim(), limit: 8 }).then(
        response => {
          if (!current) return
          setResults(response.results.filter(item => item.datasetId !== null))
          setError(null)
          setLoading(false)
        },
        (reason: Error) => {
          if (!current) return
          setError(reason.message)
          setLoading(false)
        },
      )
    }, 180)
    return () => { current = false; window.clearTimeout(timer) }
  }, [query, value])

  if (value) {
    return (
      <PickedValue
        label={label}
        title={value.displayName ?? value.name}
        identity={`${value.namespace} / ${value.name}`}
        onChange={() => onChange(null)}
      />
    )
  }

  const choose = (item: RegistryDatasetSummary) => {
    onChange(item)
    setQuery('')
    setResults([])
    setLoading(false)
  }

  return (
    <div className="lineage-picker">
      <label className="field">
        <span>{label}</span>
        <input
          value={query}
          onChange={event => {
            const next = event.target.value
            setQuery(next)
            setResults([])
            setLoading(next.trim().length > 0)
          }}
          placeholder="名前、説明、S3 URIで検索"
          autoComplete="off"
        />
      </label>
      {loading && <p className="muted lineage-picker__status">検索中…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {results.length > 0 && (
        <div className="table-scroll lineage-picker__results">
          <table className="responsive-table">
            <thead>
              <tr>
                <th scope="col">データセット</th>
                <th scope="col" className="numeric">バージョン</th>
              </tr>
            </thead>
            <tbody>
              {results.map(item => (
                <tr
                  key={item.datasetId ?? `${item.namespace}/${item.name}`}
                  className="clickable-row"
                  onClick={event => { if (!isFromRowControl(event)) choose(item) }}
                >
                  <td>
                    <button type="button" className="link-button" onClick={() => choose(item)}>
                      {item.displayName ?? item.name}
                    </button>
                    <small className="mono break-word">{item.namespace} / {item.name}</small>
                  </td>
                  <td className="numeric nowrap">{item.versionCount}件</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

interface VersionPickerProps {
  value: VersionChoice | null
  onChange: (value: VersionChoice | null) => void
  label?: string
}

export function VersionPicker({ value, onChange, label = 'データのバージョン' }: VersionPickerProps) {
  const [dataset, setDataset] = useState<RegistryDatasetSummary | null>(null)
  const [versions, setVersions] = useState<Array<{ id: string; version: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!dataset?.datasetId) return
    let current = true
    api.lineageDataset(dataset.datasetId).then(
      detail => {
        if (!current) return
        setVersions(detail.versions.map(version => ({ id: version.id, version: version.version })))
        setError(null)
        setLoading(false)
      },
      (reason: Error) => {
        if (!current) return
        setError(reason.message)
        setLoading(false)
      },
    )
    return () => { current = false }
  }, [dataset])

  if (value) {
    return (
      <PickedValue
        label={label}
        title={`${value.datasetLabel} · ${value.version}`}
        identity={`${value.namespace} / ${value.name}`}
        onChange={() => { onChange(null); setDataset(null) }}
      />
    )
  }

  return (
    <div>
      <DatasetPicker value={dataset} onChange={next => {
        setDataset(next)
        setVersions([])
        setLoading(next !== null)
      }} label={label} />
      {dataset && (
        <label className="field">
          <span>バージョン</span>
          <select
            value=""
            disabled={loading || versions.length === 0}
            onChange={event => {
              const selected = versions.find(version => version.id === event.target.value)
              if (!selected || !dataset.datasetId) return
              onChange({
                id: selected.id,
                datasetId: dataset.datasetId,
                datasetLabel: dataset.displayName ?? dataset.name,
                namespace: dataset.namespace,
                name: dataset.name,
                version: selected.version,
              })
            }}
          >
            <option value="">{loading ? '読み込み中…' : versions.length === 0 ? 'バージョンがありません' : 'バージョンを選択'}</option>
            {versions.map(version => <option key={version.id} value={version.id}>{version.version}</option>)}
          </select>
        </label>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}
    </div>
  )
}

interface VersionListPickerProps {
  values: VersionChoice[]
  onChange: (values: VersionChoice[]) => void
  label: string
}

export function VersionListPicker({ values, onChange, label }: VersionListPickerProps) {
  const [candidate, setCandidate] = useState<VersionChoice | null>(null)
  const [pickerKey, setPickerKey] = useState(0)
  return (
    <div className="lineage-version-list">
      <VersionPicker key={pickerKey} value={candidate} onChange={setCandidate} label={label} />
      {candidate && (
        <button
          type="button"
          className="button small"
          disabled={values.some(value => value.id === candidate.id)}
          onClick={() => {
            onChange([...values, candidate])
            setCandidate(null)
            setPickerKey(key => key + 1)
          }}
        >
          <Plus size={14} aria-hidden="true" />
          追加
        </button>
      )}
      {values.length > 0 && (
        <ul className="lineage-version-list__selected">
          {values.map(value => (
            <li key={value.id}>
              <span><strong>{value.datasetLabel}</strong> · <span className="mono">{value.version}</span></span>
              <button
                type="button"
                className="icon-button"
                aria-label="外す"
                title="外す"
                onClick={() => onChange(values.filter(item => item.id !== value.id))}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
