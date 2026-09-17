import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type {
  Connection,
  RegistryDatasetSummary,
  ManualDatasetRegistrationInput,
  ManualLineageRegistrationInput,
  ManualStorageLocationInput,
  ManualTransformationInput,
} from '../lib/api/types'
import { useAuth } from '../lib/auth-context'
import {
  DatasetPicker,
  VersionListPicker,
  VersionPicker,
  type VersionChoice,
} from '../components/lineage/ManualLineagePicker'

type RegistrationKind = 'dataset' | 'location' | 'run'

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim()
}

function optional(form: FormData, name: string): string | undefined {
  return text(form, name) || undefined
}

function lines(value: string): string[] {
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
}

function evidence(form: FormData): string[] {
  return lines(text(form, 'evidenceRefs'))
}

function storageInput(form: FormData): ManualStorageLocationInput {
  return {
    connectionId: text(form, 'connectionId'),
    bucket: text(form, 'bucket'),
    key: text(form, 'key'),
    status: text(form, 'status') as ManualStorageLocationInput['status'],
    isPrimary: form.get('isPrimary') === 'on',
  }
}

function transformation(form: FormData): ManualTransformationInput {
  return {
    transformationKey: text(form, 'transformationKey'),
    name: text(form, 'transformationName'),
    description: optional(form, 'transformationDescription'),
    codeRepository: optional(form, 'codeRepository'),
    defaultCodeRef: optional(form, 'defaultCodeRef'),
  }
}

function occurredAt(form: FormData): string | undefined {
  const raw = text(form, 'occurredAt')
  return raw ? new Date(raw).toISOString() : undefined
}

function ConnectionLocationFields({ connections }: { connections: Connection[] }) {
  return (
    <div className="manual-grid manual-grid--3">
      <label className="manual-field">
        <span>接続</span>
        <select name="connectionId" required defaultValue="">
          <option value="" disabled>接続を選択</option>
          {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
        </select>
      </label>
      <label className="manual-field">
        <span>バケット</span>
        <input name="bucket" required placeholder="dataset" />
      </label>
      <label className="manual-field">
        <span>パス</span>
        <input name="key" placeholder="podcast/raw/" />
      </label>
      <label className="manual-field">
        <span>状態</span>
        <select name="status" defaultValue="available">
          <option value="available">利用可能</option>
          <option value="archived">アーカイブ済み</option>
          <option value="missing">見つからない</option>
          <option value="unknown">不明</option>
        </select>
      </label>
      <label className="manual-check"><input name="isPrimary" type="checkbox" /> 主な保存場所にする</label>
    </div>
  )
}

function EvidenceField() {
  return (
    <label className="manual-field manual-field--wide">
      <span>根拠URL</span>
      <textarea name="evidenceRefs" rows={3} placeholder={'READMEやNotion、購入記録などを1行に1件'} />
    </label>
  )
}

function ResultNotice({ message, to }: { message: string; to?: string }) {
  return (
    <div className="manual-success" role="status">
      <strong>{message}</strong>
      {to && <Link to={to}>登録内容を見る</Link>}
    </div>
  )
}

function DatasetRegistrationForm({ connections }: { connections: Connection[] }) {
  const [target, setTarget] = useState<'new' | 'existing'>('new')
  const [dataset, setDataset] = useState<RegistryDatasetSummary | null>(null)
  const [withLocation, setWithLocation] = useState(true)
  const [withSource, setWithSource] = useState(false)
  const [withProcessing, setWithProcessing] = useState(false)
  const [inputs, setInputs] = useState<VersionChoice[]>([])
  const [timeStatus, setTimeStatus] = useState<'known' | 'unknown'>('unknown')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultVersionId, setResultVersionId] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (target === 'existing' && !dataset?.datasetId) {
      setError('既存のデータセットを選択してください。')
      return
    }
    const form = new FormData(event.currentTarget)
    const input: ManualDatasetRegistrationInput = {
      ...(target === 'new' ? { dataset: {
        datasetKey: text(form, 'datasetKey'), namespace: text(form, 'namespace'), name: text(form, 'name'),
        displayName: optional(form, 'displayName'), aliases: lines(text(form, 'aliases')),
        description: optional(form, 'description'), mediaType: optional(form, 'mediaType'), owner: optional(form, 'owner'),
      } } : { datasetId: dataset!.datasetId! }),
      version: {
        version: text(form, 'version'), contentHash: optional(form, 'contentHash'),
        manifestUri: optional(form, 'manifestUri'), manifestHash: optional(form, 'manifestHash'),
        schemaUri: optional(form, 'schemaUri'),
      },
      ...(withLocation ? { location: storageInput(form) } : {}),
      ...(withSource ? { source: {
        sourceKey: text(form, 'sourceKey'),
        kind: text(form, 'sourceKind') as NonNullable<ManualDatasetRegistrationInput['source']>['kind'],
        name: text(form, 'sourceName'), uri: optional(form, 'sourceUri'), vendor: optional(form, 'vendor'),
        product: optional(form, 'product'), licenseRef: optional(form, 'licenseRef'), contractRef: optional(form, 'contractRef'),
      } } : {}),
      ...(withProcessing ? { processing: {
        transformation: transformation(form), inputVersionIds: inputs.map(item => item.id),
        jobNamespace: text(form, 'jobNamespace'), jobName: text(form, 'jobName'),
        gitSha: optional(form, 'gitSha'), containerDigest: optional(form, 'containerDigest'),
        configUri: optional(form, 'configUri'), configHash: optional(form, 'configHash'),
        executionTimeStatus: timeStatus, occurredAt: timeStatus === 'known' ? occurredAt(form) : undefined,
      } } : {}),
      evidenceRefs: evidence(form),
    }
    setSaving(true)
    setError(null)
    try {
      const result = await api.registerManualDataset(input)
      const version = result.version as Record<string, unknown> | undefined
      setResultVersionId(typeof version?.id === 'string' ? version.id : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登録できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="manual-form" onSubmit={submit}>
      <section className="manual-section">
        <header><span>01</span><h3>データセット</h3></header>
        <div className="manual-segmented" role="group" aria-label="データセットの登録方法">
          <button type="button" data-active={target === 'new' || undefined} onClick={() => { setTarget('new'); setDataset(null) }}>新しく作る</button>
          <button type="button" data-active={target === 'existing' || undefined} onClick={() => setTarget('existing')}>既存にバージョンを追加</button>
        </div>
        {target === 'existing' ? <DatasetPicker value={dataset} onChange={setDataset} /> : (
          <div className="manual-grid manual-grid--2">
            <label className="manual-field"><span>表示名</span><input name="displayName" required placeholder="Podcast 日本語 原本" /></label>
            <label className="manual-field"><span>データセットキー</span><input name="datasetKey" required placeholder="podcast/ja/raw" /></label>
            <label className="manual-field"><span>名前空間</span><input name="namespace" required placeholder="mdx-speech" /></label>
            <label className="manual-field"><span>技術名</span><input name="name" required placeholder="podcast/ja/raw" /></label>
            <label className="manual-field"><span>データ形式</span><input name="mediaType" placeholder="audio" /></label>
            <label className="manual-field"><span>管理者</span><input name="owner" /></label>
            <label className="manual-field manual-field--wide"><span>別名</span><input name="aliases" placeholder="Podcast JA, 日本語Podcast" /></label>
            <label className="manual-field manual-field--wide"><span>説明</span><textarea name="description" rows={3} /></label>
          </div>
        )}
      </section>

      <section className="manual-section">
        <header><span>02</span><h3>バージョン</h3></header>
        <div className="manual-grid manual-grid--2">
          <label className="manual-field"><span>バージョン</span><input name="version" required placeholder="2026-08-27" /></label>
          <label className="manual-field"><span>内容のハッシュ</span><input name="contentHash" placeholder="sha256:..." /></label>
          <label className="manual-field"><span>ファイル一覧URI</span><input name="manifestUri" placeholder="s3://.../manifest.jsonl" /></label>
          <label className="manual-field"><span>ファイル一覧のハッシュ</span><input name="manifestHash" placeholder="sha256:..." /></label>
          <label className="manual-field manual-field--wide"><span>スキーマURI</span><input name="schemaUri" /></label>
        </div>
      </section>

      <section className="manual-section">
        <header><span>03</span><h3>保存場所</h3></header>
        <label className="manual-check"><input type="checkbox" checked={withLocation} onChange={event => setWithLocation(event.target.checked)} /> 保存場所も登録する</label>
        {withLocation && <ConnectionLocationFields connections={connections} />}
      </section>

      <section className="manual-section">
        <header><span>04</span><h3>由来と処理</h3></header>
        <div className="manual-options">
          <label className="manual-check"><input type="checkbox" checked={withSource} onChange={event => setWithSource(event.target.checked)} /> 購入元・収集元を記録する</label>
          <label className="manual-check"><input type="checkbox" checked={withProcessing} onChange={event => setWithProcessing(event.target.checked)} /> このバージョンを作った処理を記録する</label>
        </div>
        {withSource && (
          <div className="manual-subsection">
            <div className="manual-grid manual-grid--2">
              <label className="manual-field"><span>入手元キー</span><input name="sourceKey" required placeholder="vendor/corpus-name" /></label>
              <label className="manual-field"><span>種類</span><select name="sourceKind" defaultValue="purchased"><option value="purchased">購入</option><option value="crawled">収集</option><option value="provided">提供</option><option value="database">データベース</option><option value="generated">生成</option><option value="other">その他</option></select></label>
              <label className="manual-field"><span>名称</span><input name="sourceName" required /></label>
              <label className="manual-field"><span>URI</span><input name="sourceUri" placeholder="https://..." /></label>
              <label className="manual-field"><span>提供元</span><input name="vendor" /></label>
              <label className="manual-field"><span>製品名</span><input name="product" /></label>
              <label className="manual-field"><span>ライセンス参照</span><input name="licenseRef" /></label>
              <label className="manual-field"><span>契約参照</span><input name="contractRef" /></label>
            </div>
          </div>
        )}
        {withProcessing && (
          <div className="manual-subsection">
            <VersionListPicker values={inputs} onChange={setInputs} label="入力データ" />
            <div className="manual-grid manual-grid--2">
              <label className="manual-field"><span>処理名</span><input name="transformationName" required placeholder="NeMo Curator 品質フィルタ" /></label>
              <label className="manual-field"><span>処理キー</span><input name="transformationKey" required placeholder="nemo-curator-quality-filter" /></label>
              <label className="manual-field"><span>処理の名前空間</span><input name="jobNamespace" required placeholder="mdx-speech" /></label>
              <label className="manual-field"><span>処理の技術名</span><input name="jobName" required placeholder="nemo-curator-quality-filter" /></label>
              <label className="manual-field"><span>コード置き場</span><input name="codeRepository" placeholder="https://github.com/..." /></label>
              <label className="manual-field"><span>既定のコード参照</span><input name="defaultCodeRef" placeholder="commit / tag" /></label>
              <label className="manual-field"><span>Git SHA</span><input name="gitSha" /></label>
              <label className="manual-field"><span>コンテナイメージ</span><input name="containerDigest" /></label>
              <label className="manual-field"><span>設定ファイルURI</span><input name="configUri" /></label>
              <label className="manual-field"><span>設定ファイルのハッシュ</span><input name="configHash" /></label>
              <label className="manual-field"><span>実行日時</span><select value={timeStatus} onChange={event => setTimeStatus(event.target.value as 'known' | 'unknown')}><option value="unknown">不明</option><option value="known">判明している</option></select></label>
              {timeStatus === 'known' && <label className="manual-field"><span>日時</span><input name="occurredAt" type="datetime-local" required /></label>}
            </div>
          </div>
        )}
        <EvidenceField />
      </section>

      <section className="manual-section manual-review">
        <header><span>05</span><h3>確認</h3></header>
        <p>保存するとデータ台帳へ登録され、処理履歴がある場合はグラフにも反映されます。</p>
        {error && <p className="error" role="alert">{error}</p>}
        {resultVersionId && <ResultNotice message="データのバージョンを登録しました。" to={`/lineage?mode=versions&versionId=${encodeURIComponent(resultVersionId)}`} />}
        <button className="manual-submit" type="submit" disabled={saving}>{saving ? '登録中…' : '登録する'}</button>
      </section>
    </form>
  )
}

function LocationRegistrationForm({ connections }: { connections: Connection[] }) {
  const [version, setVersion] = useState<VersionChoice | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!version) return setError('データのバージョンを選択してください。')
    const form = new FormData(event.currentTarget)
    setSaving(true); setError(null); setDone(false)
    try {
      await api.registerManualLocation({ versionId: version.id, location: storageInput(form), evidenceRefs: evidence(form) })
      setDone(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登録できませんでした。')
    } finally { setSaving(false) }
  }
  return (
    <form className="manual-form" onSubmit={submit}>
      <div className="manual-guidance"><strong>同じ内容を別の場所へコピーした場合はこちら</strong><span>新しいバージョンや処理履歴は作らず、同じバージョンへ保存場所だけを追加します。</span></div>
      <section className="manual-section"><header><span>01</span><h3>バージョン</h3></header><VersionPicker value={version} onChange={setVersion} /></section>
      <section className="manual-section"><header><span>02</span><h3>保存場所</h3></header><ConnectionLocationFields connections={connections} /></section>
      <section className="manual-section"><header><span>03</span><h3>根拠</h3></header><EvidenceField /></section>
      <section className="manual-section manual-review"><header><span>04</span><h3>確認</h3></header>
        {error && <p className="error" role="alert">{error}</p>}
        {done && <ResultNotice message="保存場所を追加しました。" to={version ? `/lineage?mode=versions&versionId=${encodeURIComponent(version.id)}` : undefined} />}
        <button className="manual-submit" type="submit" disabled={saving}>{saving ? '登録中…' : '保存場所を追加'}</button>
      </section>
    </form>
  )
}

function RunRegistrationForm() {
  const [inputs, setInputs] = useState<VersionChoice[]>([])
  const [outputs, setOutputs] = useState<VersionChoice[]>([])
  const [timeStatus, setTimeStatus] = useState<'known' | 'unknown'>('unknown')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inputs.length === 0 || outputs.length === 0) return setError('入力と出力を1件以上選択してください。')
    if (inputs.some(input => outputs.some(output => output.id === input.id))) return setError('同じバージョンを入力と出力の両方には指定できません。コピーは「保存場所」を使ってください。')
    const form = new FormData(event.currentTarget)
    const input: ManualLineageRegistrationInput = {
      transformation: transformation(form), inputVersionIds: inputs.map(item => item.id), outputVersionIds: outputs.map(item => item.id),
      jobNamespace: text(form, 'jobNamespace'), jobName: text(form, 'jobName'), gitSha: optional(form, 'gitSha'),
      containerDigest: optional(form, 'containerDigest'), configUri: optional(form, 'configUri'), configHash: optional(form, 'configHash'),
      executionTimeStatus: timeStatus, occurredAt: timeStatus === 'known' ? occurredAt(form) : undefined, evidenceRefs: evidence(form),
    }
    setSaving(true); setError(null); setRunId(null)
    try {
      const result = await api.registerManualLineage(input)
      setRunId(typeof result.id === 'string' ? result.id : 'registered')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登録できませんでした。')
    } finally { setSaving(false) }
  }
  const outputLink = outputs[0] ? `/lineage?mode=versions&versionId=${encodeURIComponent(outputs[0].id)}` : undefined
  return (
    <form className="manual-form" onSubmit={submit}>
      <div className="manual-guidance"><strong>既存データ同士の処理履歴を補完します</strong><span>不明な実行時刻は不明のまま保存し、根拠のない親子関係は登録しないでください。</span></div>
      <section className="manual-section"><header><span>01</span><h3>入出力</h3></header>
        <div className="manual-grid manual-grid--2 manual-grid--top"><VersionListPicker values={inputs} onChange={setInputs} label="入力データ" /><VersionListPicker values={outputs} onChange={setOutputs} label="出力データ" /></div>
      </section>
      <section className="manual-section"><header><span>02</span><h3>処理</h3></header>
        <div className="manual-grid manual-grid--2">
          <label className="manual-field"><span>処理名</span><input name="transformationName" required /></label>
          <label className="manual-field"><span>処理キー</span><input name="transformationKey" required /></label>
          <label className="manual-field"><span>処理の名前空間</span><input name="jobNamespace" required /></label>
          <label className="manual-field"><span>処理の技術名</span><input name="jobName" required /></label>
          <label className="manual-field"><span>コード置き場</span><input name="codeRepository" /></label>
          <label className="manual-field"><span>既定のコード参照</span><input name="defaultCodeRef" /></label>
          <label className="manual-field"><span>Git SHA</span><input name="gitSha" /></label>
          <label className="manual-field"><span>コンテナイメージ</span><input name="containerDigest" /></label>
          <label className="manual-field"><span>設定ファイルURI</span><input name="configUri" /></label>
          <label className="manual-field"><span>設定ファイルのハッシュ</span><input name="configHash" /></label>
          <label className="manual-field"><span>実行日時</span><select value={timeStatus} onChange={event => setTimeStatus(event.target.value as 'known' | 'unknown')}><option value="unknown">不明</option><option value="known">判明している</option></select></label>
          {timeStatus === 'known' && <label className="manual-field"><span>日時</span><input name="occurredAt" type="datetime-local" required /></label>}
        </div>
      </section>
      <section className="manual-section"><header><span>03</span><h3>根拠</h3></header><EvidenceField /></section>
      <section className="manual-section manual-review"><header><span>04</span><h3>確認</h3></header>
        {error && <p className="error" role="alert">{error}</p>}
        {runId && <ResultNotice message="処理履歴を登録しました。" to={outputLink} />}
        <button className="manual-submit" type="submit" disabled={saving}>{saving ? '登録中…' : '処理履歴を登録'}</button>
      </section>
    </form>
  )
}

export default function LineageRegisterPage() {
  const { user } = useAuth()
  const [kind, setKind] = useState<RegistrationKind>('dataset')
  const [connections, setConnections] = useState<Connection[]>([])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const allowed = user?.permissions.includes('lineage:curate') ?? false

  useEffect(() => {
    if (!allowed) return
    api.listConnections().then(setConnections, (reason: Error) => setConnectionError(reason.message))
  }, [allowed])

  if (!allowed) {
    return <section><header className="page-head"><h2>DataLineage</h2></header><p className="error">手動登録の権限がありません。</p></section>
  }

  return (
    <section className="manual-lineage-page">
      <header className="page-head"><h2>DataLineage</h2><Link className="ghost" to="/lineage">一覧に戻る</Link></header>
      <nav className="manual-kind-nav" aria-label="登録種別">
        <button type="button" data-active={kind === 'dataset' || undefined} onClick={() => setKind('dataset')}>データセット</button>
        <button type="button" data-active={kind === 'location' || undefined} onClick={() => setKind('location')}>保存場所</button>
        <button type="button" data-active={kind === 'run' || undefined} onClick={() => setKind('run')}>処理履歴</button>
      </nav>
      {connectionError && <p className="error" role="alert">{connectionError}</p>}
      {kind === 'dataset' && <DatasetRegistrationForm connections={connections} />}
      {kind === 'location' && <LocationRegistrationForm connections={connections} />}
      {kind === 'run' && <RunRegistrationForm />}
    </section>
  )
}
