import { useState } from 'react'
import type {
  Connection,
  ConnectionCreateInput,
  ConnectionUpdateInput,
  ListObjectsVersion,
} from '../lib/api/types'

type Mode =
  | { kind: 'create'; onSubmit: (input: ConnectionCreateInput) => Promise<void> }
  | { kind: 'edit'; current: Connection; onSubmit: (input: ConnectionUpdateInput) => Promise<void> }

interface Props {
  mode: Mode
  onClose: () => void
}

export function ConnectionForm({ mode, onClose }: Props) {
  const isEdit = mode.kind === 'edit'
  const current = mode.kind === 'edit' ? mode.current : null

  const [name, setName] = useState(current?.name ?? '')
  const [endpoint, setEndpoint] = useState(current?.endpoint ?? '')
  const [region, setRegion] = useState(current?.region ?? 'auto')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [forcePathStyle, setForcePathStyle] = useState(current?.forcePathStyle ?? true)
  const [listObjectsVersion, setListObjectsVersion] =
    useState<ListObjectsVersion>(current?.listObjectsVersion ?? 'v2')
  const [showSecret, setShowSecret] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const titleId = 'connection-form-title'

  const validateClientSide = (): string | null => {
    if (!name.trim()) return '名前を入力してください'
    if (!endpoint.trim()) return 'エンドポイントを入力してください'
    if (!region.trim()) return 'リージョンを入力してください'
    if (!isEdit) {
      if (!accessKeyId.trim()) return 'アクセスキー ID を入力してください'
      if (!secretAccessKey) return 'シークレットアクセスキーを入力してください'
    }
    return null
  }

  const submit = async () => {
    const clientError = validateClientSide()
    if (clientError) {
      setError(clientError)
      return
    }

    setSaving(true)
    setError(null)
    try {
      if (mode.kind === 'create') {
        const input: ConnectionCreateInput = {
          name: name.trim(),
          endpoint: endpoint.trim(),
          region: region.trim(),
          accessKeyId: accessKeyId.trim(),
          secretAccessKey,
          forcePathStyle,
          listObjectsVersion,
        }
        await mode.onSubmit(input)
      } else {
        const cur = mode.current
        const input: ConnectionUpdateInput = {}
        if (name.trim() !== cur.name) input.name = name.trim()
        if (endpoint.trim() !== cur.endpoint) input.endpoint = endpoint.trim()
        if (region.trim() !== cur.region) input.region = region.trim()
        if (forcePathStyle !== cur.forcePathStyle) input.forcePathStyle = forcePathStyle
        if (listObjectsVersion !== cur.listObjectsVersion) input.listObjectsVersion = listObjectsVersion
        if (accessKeyId.trim()) input.accessKeyId = accessKeyId.trim()
        if (secretAccessKey) input.secretAccessKey = secretAccessKey
        await mode.onSubmit(input)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const accessKeyPlaceholder = isEdit && current
    ? `${current.accessKeyIdMasked} — 空のままで変更しない`
    : ''
  const secretPlaceholder = isEdit ? '空のままで変更しない' : ''

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <p className="kicker">Settings · 接続</p>
        <h3 id={titleId}>{isEdit ? '接続を編集' : '接続を追加'}</h3>

        <label className="modal-field">
          <span className="label">名前</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例: production"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="modal-field">
          <span className="label">エンドポイント</span>
          <input
            type="url"
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            placeholder="https://s3.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="modal-field">
          <span className="label">リージョン</span>
          <input
            value={region}
            onChange={e => setRegion(e.target.value)}
            placeholder="auto"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="modal-field">
          <span className="label">アクセスキー ID</span>
          <input
            value={accessKeyId}
            onChange={e => setAccessKeyId(e.target.value)}
            placeholder={accessKeyPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="modal-field">
          <span className="label">シークレットアクセスキー</span>
          <div className="relative flex items-stretch gap-2">
            <input
              className="flex-1"
              type={showSecret ? 'text' : 'password'}
              value={secretAccessKey}
              onChange={e => setSecretAccessKey(e.target.value)}
              placeholder={secretPlaceholder}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="ghost shrink-0"
              onClick={() => setShowSecret(s => !s)}
              aria-label={showSecret ? 'シークレットを隠す' : 'シークレットを表示'}
            >
              {showSecret ? '隠す' : '表示'}
            </button>
          </div>
        </label>

        {/* Path-style URL: 単一の選択肢として ListObjects と同じ構造で扱う。 */}
        <fieldset className="modal-field">
          <legend className="label">Path-style URL</legend>
          <label className="modal-choice">
            <input
              type="checkbox"
              checked={forcePathStyle}
              onChange={e => setForcePathStyle(e.target.checked)}
            />
            <div>
              <strong>Path-style URL を使用する</strong>
              <small>
                MinIO や自前の S3 互換サーバはこれを ON にしないと動かないことが
                多いです。AWS S3 / Cloudflare R2 などはどちらでも OK。迷ったら
                ON のままで大丈夫。
              </small>
            </div>
          </label>
        </fieldset>

        {/* ListObjects API バージョン: V2 を理解しない MDX 等は v1 を選ぶ。 */}
        <fieldset className="modal-field">
          <legend className="label">ListObjects API バージョン</legend>
          <label className="modal-choice">
            <input
              type="radio"
              name="listObjectsVersion"
              value="v2"
              checked={listObjectsVersion === 'v2'}
              onChange={() => setListObjectsVersion('v2')}
            />
            <div>
              <strong>v2</strong>
              <small>AWS S3 / Cloudflare R2 / MinIO など、新しい実装向け (既定)。</small>
            </div>
          </label>
          <label className="modal-choice">
            <input
              type="radio"
              name="listObjectsVersion"
              value="v1"
              checked={listObjectsVersion === 'v1'}
              onChange={() => setListObjectsVersion('v1')}
            />
            <div>
              <strong>v1</strong>
              <small>
                <code>s3ds.mdx.jp</code> や 古い NetApp StorageGRID 等、
                V2 を理解しないサーバ向け (ページが進まないときに切り替え)。
              </small>
            </div>
          </label>
        </fieldset>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={saving}>キャンセル</button>
          <button onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
