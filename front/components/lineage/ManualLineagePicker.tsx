import { useEffect, useState } from 'react'
import { api } from '../../lib/api/client'
import type { RegistryDatasetSummary } from '../../lib/api/types'

export interface VersionChoice {
  id: string
  datasetId: string
  datasetLabel: string
  namespace: string
  name: string
  version: string
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
      <div className="manual-picker__selected">
        <div>
          <strong>{value.displayName ?? value.name}</strong>
          <span>{value.namespace} / {value.name}</span>
        </div>
        <button type="button" className="ghost" onClick={() => onChange(null)}>変更</button>
      </div>
    )
  }

  return (
    <div className="manual-picker">
      <label className="manual-field">
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
      {loading && <small>検索中…</small>}
      {error && <p className="error" role="alert">{error}</p>}
      {results.length > 0 && (
        <ul className="manual-picker__results">
          {results.map(item => (
            <li key={item.datasetId ?? `${item.namespace}/${item.name}`}>
                  <button type="button" onClick={() => { onChange(item); setQuery(''); setResults([]); setLoading(false) }}>
                <strong>{item.displayName ?? item.name}</strong>
                <span>{item.namespace} / {item.name} · バージョン {item.versionCount}件</span>
              </button>
            </li>
          ))}
        </ul>
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
      <div className="manual-picker__selected">
        <div>
          <strong>{value.datasetLabel} · {value.version}</strong>
          <span>{value.namespace} / {value.name}</span>
        </div>
        <button type="button" className="ghost" onClick={() => { onChange(null); setDataset(null) }}>変更</button>
      </div>
    )
  }

  return (
    <div className="manual-version-picker">
      <DatasetPicker value={dataset} onChange={next => {
        setDataset(next)
        setVersions([])
        setLoading(next !== null)
      }} label={label} />
      {dataset && (
        <label className="manual-field">
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
      {error && <p className="error" role="alert">{error}</p>}
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
    <div className="manual-version-list">
      <VersionPicker key={pickerKey} value={candidate} onChange={setCandidate} label={label} />
      {candidate && (
        <button
          type="button"
          className="ghost"
          disabled={values.some(value => value.id === candidate.id)}
          onClick={() => {
            onChange([...values, candidate])
            setCandidate(null)
            setPickerKey(key => key + 1)
          }}
        >追加</button>
      )}
      {values.length > 0 && (
        <ul className="manual-version-list__selected">
          {values.map(value => (
            <li key={value.id}>
              <span><strong>{value.datasetLabel}</strong> · {value.version}</span>
              <button type="button" onClick={() => onChange(values.filter(item => item.id !== value.id))}>外す</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
