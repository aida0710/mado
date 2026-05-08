import { useReducer } from 'react'
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

interface FormState {
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  listObjectsVersion: ListObjectsVersion
  showSecret: boolean
  saving: boolean
  error: string | null
}

type FieldName = Exclude<keyof FormState, 'saving' | 'error'>

type Action =
  | { type: 'setField'; field: FieldName; value: FormState[FieldName] }
  | { type: 'startSave' }
  | { type: 'saveFailed'; error: string }
  | { type: 'saveDone' }
  | { type: 'setError'; error: string | null }

function reducer(state: FormState, action: Action): FormState {
  switch (action.type) {
    case 'setField':
      return { ...state, [action.field]: action.value }
    case 'startSave':
      return { ...state, saving: true, error: null }
    case 'saveFailed':
      return { ...state, saving: false, error: action.error }
    case 'saveDone':
      return { ...state, saving: false }
    case 'setError':
      return { ...state, error: action.error }
  }
}

function initialState(current: Connection | null): FormState {
  return {
    name: current?.name ?? '',
    endpoint: current?.endpoint ?? '',
    region: current?.region ?? 'auto',
    accessKeyId: '',
    secretAccessKey: '',
    forcePathStyle: current?.forcePathStyle ?? true,
    listObjectsVersion: current?.listObjectsVersion ?? 'v2',
    showSecret: false,
    saving: false,
    error: null,
  }
}

export function ConnectionForm({ mode, onClose }: Props) {
  const isEdit = mode.kind === 'edit'
  const current = mode.kind === 'edit' ? mode.current : null

  const [state, dispatch] = useReducer(reducer, current, initialState)
  const {
    name, endpoint, region, accessKeyId, secretAccessKey,
    forcePathStyle, listObjectsVersion, showSecret, saving, error,
  } = state

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
      dispatch({ type: 'setError', error: clientError })
      return
    }

    dispatch({ type: 'startSave' })
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
      dispatch({ type: 'saveDone' })
    } catch (e) {
      dispatch({ type: 'saveFailed', error: (e as Error).message })
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
            onChange={e => dispatch({ type: 'setField', field: 'name', value: e.target.value })}
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
            onChange={e => dispatch({ type: 'setField', field: 'endpoint', value: e.target.value })}
            placeholder="https://s3.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="modal-field">
          <span className="label">リージョン</span>
          <input
            value={region}
            onChange={e => dispatch({ type: 'setField', field: 'region', value: e.target.value })}
            placeholder="auto"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="modal-field">
          <span className="label">アクセスキー ID</span>
          <input
            value={accessKeyId}
            onChange={e => dispatch({ type: 'setField', field: 'accessKeyId', value: e.target.value })}
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
              onChange={e => dispatch({ type: 'setField', field: 'secretAccessKey', value: e.target.value })}
              placeholder={secretPlaceholder}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="ghost shrink-0"
              onClick={() => dispatch({ type: 'setField', field: 'showSecret', value: !showSecret })}
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
              aria-label="Path-style URL を使用する"
              checked={forcePathStyle}
              onChange={e => dispatch({ type: 'setField', field: 'forcePathStyle', value: e.target.checked })}
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

        {/* ListObjects API バージョン: V2 を理解しないサーバ
            (DDN 製のオブジェクトストレージ等) は v1 を選ぶ。 */}
        <fieldset className="modal-field">
          <legend className="label">ListObjects API バージョン</legend>
          <label className="modal-choice">
            <input
              type="radio"
              name="listObjectsVersion"
              value="v2"
              aria-label="ListObjects v2"
              checked={listObjectsVersion === 'v2'}
              onChange={() => dispatch({ type: 'setField', field: 'listObjectsVersion', value: 'v2' })}
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
              aria-label="ListObjects v1"
              checked={listObjectsVersion === 'v1'}
              onChange={() => dispatch({ type: 'setField', field: 'listObjectsVersion', value: 'v1' })}
            />
            <div>
              <strong>v1</strong>
              <small>
                DDN 製のオブジェクトストレージや古い NetApp StorageGRID 等、
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
