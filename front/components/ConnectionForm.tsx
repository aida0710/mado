import { useEffect, useReducer, useState } from 'react'
import {
  ALL_CAPABILITIES_ON, CAPABILITY_UI, PROVIDER_LABELS, STORAGE_CLASS_OPTIONS,
} from '../lib/api/types'
import { api } from '../lib/api/client'
import type {
  Capabilities,
  Capability,
  Connection,
  ConnectionAccessUser,
  ConnectionCreateInput,
  ConnectionPricingInput,
  ConnectionUpdateInput,
  ListObjectsVersion,
  Provider,
  StorageClassKey,
} from '../lib/api/types'

/** 容量の入力単位。fmtSize が 1024 系なので、表示と揃えて TiB で扱う。 */
const TIB = 1024 ** 4
const CAPACITY_INTERVALS = [
  [21600, '6時間'], [43200, '12時間'], [86400, '24時間'],
  [259200, '3日'], [604800, '7日'],
] as const

type Mode =
  | { kind: 'create'; onSubmit: (input: ConnectionCreateInput) => Promise<void> }
  | { kind: 'edit'; current: Connection; onSubmit: (input: ConnectionUpdateInput) => Promise<void> }

interface Props {
  mode: Mode
  onClose: () => void
  presentation?: 'modal' | 'page'
}

interface FormState {
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  listObjectsVersion: ListObjectsVersion
  capabilities: Capabilities
  visibilityMode: 'public' | 'whitelist'
  allowedUserIds: string[]
  /** 配下の走査を許可するか。 */
  scanEnabled: boolean
  capacityMetricsEnabled: boolean
  /** 一覧キャッシュの保持秒数。 */
  listCacheTtlSec: number
  /** connection配下の全bucketに適用する容量計測設定。 */
  capacityTrackingEnabled: boolean
  capacityTrackingIntervalSeconds: number
  // ── 転送見積もり (spec: 2026-08-22-transfer-estimate-design.md) ──
  // 単価の手動上書き (cost.*) は API にはあるが、ここには出していない。
  // カタログに載っているリージョンなら触る必要が無いため。
  /** '' = エンドポイントから自動判定。 */
  pricingProvider: Provider | ''
  pricingStorageClass: StorageClassKey
  pricingReadMbps: number
  pricingWriteMbps: number
  /** '' = 未設定 (容量の警告を出さない)。単位は TiB。 */
  pricingCapacityTb: number | ''
  pricingInstability: number
  /** '' = カタログに従う。料金 API の無いプロバイダで実契約単価を入れる用。 */
  pricingStoragePerGbMonth: number | ''
  showSecret: boolean
  saving: boolean
  error: string | null
}

type FieldName = Exclude<keyof FormState, 'saving' | 'error' | 'capabilities' | 'allowedUserIds'>

type Action =
  | { type: 'setField'; field: FieldName; value: FormState[FieldName] }
  | { type: 'toggleCapability'; cap: Capability; value: boolean }
  | { type: 'toggleAllowedUser'; userId: string; value: boolean }
  | { type: 'startSave' }
  | { type: 'saveFailed'; error: string }
  | { type: 'saveDone' }
  | { type: 'setError'; error: string | null }

function reducer(state: FormState, action: Action): FormState {
  switch (action.type) {
    case 'setField':
      if (action.field === 'scanEnabled' && action.value === false) {
        return { ...state, scanEnabled: false, capacityTrackingEnabled: false }
      }
      if (action.field === 'capacityMetricsEnabled' && action.value === false) {
        return { ...state, capacityMetricsEnabled: false, capacityTrackingEnabled: false }
      }
      return { ...state, [action.field]: action.value }
    case 'toggleCapability': {
      const capabilities = { ...state.capabilities, [action.cap]: action.value }
      // README の編集は読み込み必須 (API も 400 で弾く)。読み込みを切ったら
      // 編集も一緒に落として、保存してから怒られるのを防ぐ。
      if (action.cap === 'readmeRead' && !action.value) capabilities.readmeWrite = false
      return { ...state, capabilities }
    }
    case 'toggleAllowedUser': {
      const allowedUserIds = action.value
        ? [...new Set([...state.allowedUserIds, action.userId])].sort()
        : state.allowedUserIds.filter(id => id !== action.userId)
      return { ...state, allowedUserIds }
    }
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
    capabilities: current?.capabilities ?? ALL_CAPABILITIES_ON,
    visibilityMode: current?.visibility.mode ?? 'public',
    allowedUserIds: current?.visibility.allowedUsers.map(user => user.id).sort() ?? [],
    scanEnabled: current?.scanEnabled ?? true,
    capacityMetricsEnabled: current?.capacityMetricsEnabled ?? true,
    listCacheTtlSec: current?.listCacheTtlSec ?? 86400,
    capacityTrackingEnabled: current?.capacityTracking?.enabled ?? false,
    capacityTrackingIntervalSeconds: current?.capacityTracking?.intervalSeconds ?? 86400,
    pricingProvider: current?.pricing.providerExplicit ? current.pricing.provider : '',
    pricingStorageClass: current?.pricing.storageClass ?? 'STANDARD',
    pricingReadMbps: current?.pricing.readMbps ?? 300,
    pricingWriteMbps: current?.pricing.writeMbps ?? 300,
    pricingCapacityTb: current?.pricing.capacityBytes != null
      ? Math.round((current.pricing.capacityBytes / TIB) * 10) / 10
      : '',
    pricingInstability: current?.pricing.instability ?? 0.5,
    pricingStoragePerGbMonth: current?.pricing.storagePerGbMonth ?? '',
    showSecret: false,
    saving: false,
    error: null,
  }
}

export function ConnectionForm({ mode, onClose, presentation = 'modal' }: Props) {
  const isEdit = mode.kind === 'edit'
  const current = mode.kind === 'edit' ? mode.current : null

  const [state, dispatch] = useReducer(reducer, current, initialState)
  const [accessUsers, setAccessUsers] = useState<ConnectionAccessUser[]>([])
  const [accessUsersError, setAccessUsersError] = useState<string | null>(null)
  const {
    name, endpoint, region, accessKeyId, secretAccessKey,
    forcePathStyle, listObjectsVersion, capabilities, showSecret, saving, error,
    visibilityMode, allowedUserIds,
    scanEnabled,
    capacityMetricsEnabled,
    listCacheTtlSec,
    capacityTrackingEnabled, capacityTrackingIntervalSeconds,
    pricingProvider, pricingStorageClass, pricingReadMbps, pricingWriteMbps,
    pricingCapacityTb, pricingInstability, pricingStoragePerGbMonth,
  } = state

  useEffect(() => {
    let active = true
    api.listConnectionAccessUsers()
      .then(body => { if (active) setAccessUsers(body.users) })
      .catch(cause => {
        if (active) setAccessUsersError(cause instanceof Error ? cause.message : 'ユーザーを取得できませんでした')
      })
    return () => { active = false }
  }, [])

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
          capabilities,
          visibility: { mode: visibilityMode, allowedUserIds },
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
        // 権限も差分。変えたトグルだけ送る (API 側も差分更新)。
        const capChanges: Partial<Capabilities> = {}
        for (const { key } of CAPABILITY_UI) {
          if (capabilities[key] !== cur.capabilities[key]) capChanges[key] = capabilities[key]
        }
        if (Object.keys(capChanges).length > 0) input.capabilities = capChanges
        const currentAllowedUserIds = cur.visibility.allowedUsers.map(user => user.id).sort()
        const allowedUsersChanged = allowedUserIds.length !== currentAllowedUserIds.length
          || allowedUserIds.some((id, index) => id !== currentAllowedUserIds[index])
        if (visibilityMode !== cur.visibility.mode || allowedUsersChanged) {
          input.visibility = { mode: visibilityMode, allowedUserIds }
        }
        if (scanEnabled !== cur.scanEnabled) input.scanEnabled = scanEnabled
        if (capacityMetricsEnabled !== (cur.capacityMetricsEnabled ?? true)) {
          input.capacityMetricsEnabled = capacityMetricsEnabled
        }
        if (listCacheTtlSec !== cur.listCacheTtlSec) input.listCacheTtlSec = listCacheTtlSec
        const currentCapacityTracking = cur.capacityTracking ?? { enabled: false, intervalSeconds: 86400 }
        if (capacityTrackingEnabled !== currentCapacityTracking.enabled
            || capacityTrackingIntervalSeconds !== currentCapacityTracking.intervalSeconds) {
          input.capacityTracking = {
            enabled: capacityTrackingEnabled,
            intervalSeconds: capacityTrackingIntervalSeconds,
          }
        }

        // 見積もり設定も差分。**null は「既定に戻す」** (API 側で行を消す) で、
        // 未指定の「触らない」とは別物なので、自動判定に戻したいときは
        // null を明示的に送る。
        const cp = cur.pricing
        const pricing: ConnectionPricingInput = {}
        const wantProvider = pricingProvider === '' ? null : pricingProvider
        if (wantProvider !== (cp.providerExplicit ? cp.provider : null)) {
          pricing.provider = wantProvider
        }
        if (pricingStorageClass !== (cp.storageClass ?? 'STANDARD')) {
          pricing.storageClass = pricingStorageClass
        }
        if (pricingReadMbps !== cp.readMbps) pricing.readMbps = pricingReadMbps
        if (pricingWriteMbps !== cp.writeMbps) pricing.writeMbps = pricingWriteMbps
        if (pricingInstability !== cp.instability) pricing.instability = pricingInstability
        const wantCapacity = pricingCapacityTb === '' ? null : Math.round(pricingCapacityTb * TIB)
        if (wantCapacity !== cp.capacityBytes) pricing.capacityBytes = wantCapacity
        const wantRate = pricingStoragePerGbMonth === '' ? null : pricingStoragePerGbMonth
        if (wantRate !== cp.storagePerGbMonth) pricing.storagePerGbMonth = wantRate
        if (Object.keys(pricing).length > 0) input.pricing = pricing

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

  const form = (
      <div
        className={presentation === 'page' ? 'modal connection-form--page' : 'modal'}
        role={presentation === 'modal' ? 'dialog' : undefined}
        aria-modal={presentation === 'modal' ? 'true' : undefined}
        aria-labelledby={titleId}
      >
        <p className="kicker">Settings · 接続</p>
        <h3 id={titleId}>{isEdit ? '接続を編集' : '接続を追加'}</h3>

        <h4 className="connection-form__section-title">基本情報</h4>
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
        <h4 className="connection-form__section-title">認証情報</h4>
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

        <fieldset className="modal-field">
          <legend className="label">ユーザーからの表示</legend>
          <small className="mb-1 block text-ink-7">
            通常は全員に表示します。ホワイトリストでは、選択したユーザーと接続管理者だけが利用できます。
            許可されていないユーザーには接続自体が表示されず、URLを直接開いても404になります。
          </small>
          <label className="modal-choice">
            <input
              type="radio"
              name="visibilityMode"
              aria-label="全員に表示"
              checked={visibilityMode === 'public'}
              onChange={() => dispatch({ type: 'setField', field: 'visibilityMode', value: 'public' })}
            />
            <div><strong>全員に表示</strong><small>既定。ログインできる全ユーザーがこの接続を利用できます。</small></div>
          </label>
          <label className="modal-choice">
            <input
              type="radio"
              name="visibilityMode"
              aria-label="ホワイトリスト"
              checked={visibilityMode === 'whitelist'}
              onChange={() => dispatch({ type: 'setField', field: 'visibilityMode', value: 'whitelist' })}
            />
            <div><strong>ホワイトリスト</strong><small>下で選択したユーザーだけに表示します。接続管理者は常にアクセスできます。</small></div>
          </label>
          {visibilityMode === 'whitelist' && (
            <div className="mt-2 grid gap-1" aria-label="接続を許可するユーザー">
              {accessUsersError && <p className="error" role="alert">{accessUsersError}</p>}
              {!accessUsersError && accessUsers.length === 0 && (
                <small className="text-ink-7">選択できるユーザーがいません。接続管理者だけが利用できます。</small>
              )}
              {accessUsers.map(user => (
                <label className="modal-choice" key={user.id}>
                  <input
                    type="checkbox"
                    aria-label={`${user.displayName}を許可`}
                    checked={allowedUserIds.includes(user.id)}
                    onChange={event => dispatch({
                      type: 'toggleAllowedUser', userId: user.id, value: event.target.checked,
                    })}
                  />
                  <div>
                    <strong>{user.displayName}{user.status === 'disabled' ? '（無効）' : ''}</strong>
                    <small>{user.username ?? user.email ?? user.id}</small>
                  </div>
                </label>
              ))}
              {allowedUserIds.length === 0 && (
                <small className="text-ink-7">誰も選択しない場合、接続管理者だけが利用できます。</small>
              )}
            </div>
          )}
        </fieldset>

        <h4 className="connection-form__section-title">互換性</h4>
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
            (V1 only の S3 互換実装) は v1 を選ぶ。 */}
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
                ListObjectsV2 を理解しない古い S3 互換実装、
                V2 を理解しないサーバ向け (ページが進まないときに切り替え)。
              </small>
            </div>
          </label>
        </fieldset>

        {/* 接続ごとの権限。認証のあるツールではないのでアクセス制御ではなく
            誤操作の防止 — Deep Archive のように「一覧は見たいが本体には触りたく
            ない」接続で危険な導線を閉じるためのもの。UI で隠すだけでなく API 側も
            403 で止める。 */}
        <fieldset className="modal-field">
          <legend className="label">この接続で許可する操作</legend>
          <small className="mb-1 block text-ink-7">
            オフにすると画面から導線が消え、共有 URL を直接開いても 403 になります。
            既定はすべて許可です。
          </small>
          {CAPABILITY_UI.map(({ key, label, help }) => {
            // README 編集は読み込みが前提 (API も 400 で弾く)。
            const disabled = key === 'readmeWrite' && !capabilities.readmeRead
            return (
              <label className="modal-choice" key={key}>
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={capabilities[key]}
                  disabled={disabled}
                  onChange={e => dispatch({ type: 'toggleCapability', cap: key, value: e.target.checked })}
                />
                <div>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </div>
              </label>
            )
          })}
        </fieldset>

        <fieldset className="modal-field">
          <legend>この接続の動作</legend>
          <label className="modal-choice">
            <input
              type="checkbox"
              aria-label="配下の走査を許可する"
              checked={scanEnabled}
              onChange={e => dispatch({ type: 'setField', field: 'scanEnabled', value: e.target.checked })}
            />
            <div>
              <strong>配下の走査を許可する</strong>
              <small>
                ディレクトリ配下のオブジェクト数・サイズを数えます。54 万キー規模の
                バケットでは数分かかるので、走らせたくない接続ではオフに。
              </small>
            </div>
          </label>
          {isEdit && (
            <label className="modal-choice">
              <input
                type="checkbox"
                aria-label="バケットのメトリクス集計を許可する"
                checked={capacityMetricsEnabled}
                disabled={!scanEnabled}
                onChange={e => dispatch({ type: 'setField', field: 'capacityMetricsEnabled', value: e.target.checked })}
              />
              <div>
                <strong>バケットのメトリクス集計を許可する</strong>
                <small>全バケットの容量とオブジェクト数を集計する操作を許可します。</small>
              </div>
            </label>
          )}
          {isEdit && (
            <div className="mt-3 border-t border-rule pt-3">
              <label className={`modal-choice ${!scanEnabled || !capacityMetricsEnabled ? 'opacity-50' : ''}`}>
                <input
                  type="checkbox"
                  aria-label="全バケットの容量を定期計測する"
                  checked={capacityTrackingEnabled}
                  disabled={!scanEnabled || !capacityMetricsEnabled}
                  onChange={e => dispatch({ type: 'setField', field: 'capacityTrackingEnabled', value: e.target.checked })}
                />
                <div>
                  <strong>全バケットの容量を定期計測する</strong>
                  <small>このコネクションにある全バケットの容量とオブジェクト数を記録します。</small>
                </div>
              </label>
              <label className={`modal-choice ${!scanEnabled || !capacityMetricsEnabled || !capacityTrackingEnabled ? 'opacity-50' : ''}`}>
                <select
                  aria-label="容量の計測周期"
                  value={capacityTrackingIntervalSeconds}
                  disabled={!scanEnabled || !capacityMetricsEnabled || !capacityTrackingEnabled}
                  onChange={e => dispatch({
                    type: 'setField', field: 'capacityTrackingIntervalSeconds', value: Number(e.target.value),
                  })}
                >
                  {CAPACITY_INTERVALS.map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
                </select>
                <div>
                  <strong>容量の計測周期</strong>
                  <small>既定は24時間。すべてのバケットへ同じ周期を適用します。</small>
                </div>
              </label>
            </div>
          )}
          <label className="modal-choice">
            <input
              type="number"
              min={1}
              aria-label="一覧キャッシュの保持秒数"
              value={listCacheTtlSec}
              onChange={e => dispatch({
                type: 'setField', field: 'listCacheTtlSec', value: Number(e.target.value),
              })}
            />
            <div>
              <strong>一覧キャッシュの保持 (秒)</strong>
              <small>
                既定 86400 (24 時間)。この接続の一覧をサーバー側で何秒保持するか。
                更新が激しい接続は短くします。
              </small>
            </div>
          </label>
        </fieldset>

        {/* 転送見積もりのプロファイル (spec: 2026-08-22-transfer-estimate-design.md)。
            作成時は出さない — 既定 (エンドポイントからの推定) で見積もりは出るので、
            接続を足す時点で決めさせる必要が無い。 */}
        {isEdit && current && (
          <fieldset className="modal-field">
            <legend>転送の見積もり</legend>
            <small className="mb-1 block text-ink-7">
              「配下の集計 → 移送の見積もり」で使う値です。触らなくても見積もりは出ます。
            </small>

            <label className="modal-choice">
              <select
                aria-label="プロバイダ"
                value={pricingProvider}
                onChange={e => dispatch({
                  type: 'setField',
                  field: 'pricingProvider',
                  value: e.target.value as Provider | '',
                })}
              >
                <option value="">
                  自動判定 ({PROVIDER_LABELS[current.pricing.provider]})
                </option>
                {(Object.keys(PROVIDER_LABELS) as Provider[]).map(p => (
                  <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                ))}
              </select>
              <div>
                <strong>プロバイダ</strong>
                <small>
                  料金の計算方法。既定はエンドポイントのホスト名からの推定で、
                  社内ストレージは費用 0 として扱います。
                </small>
              </div>
            </label>

            {(pricingProvider || current.pricing.provider) === 'aws' && (
              <label className="modal-choice">
                <select
                  aria-label="ストレージクラス"
                  value={pricingStorageClass}
                  onChange={e => dispatch({
                    type: 'setField',
                    field: 'pricingStorageClass',
                    value: e.target.value as StorageClassKey,
                  })}
                >
                  {STORAGE_CLASS_OPTIONS.map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                <div>
                  <strong>ストレージクラス</strong>
                  <small>
                    {STORAGE_CLASS_OPTIONS.find(o => o.key === pricingStorageClass)?.help}
                  </small>
                </div>
              </label>
            )}

            <label className="modal-choice">
              <input
                type="number"
                min={1}
                aria-label="読み出し帯域 (MB/s)"
                value={pricingReadMbps}
                onChange={e => dispatch({
                  type: 'setField', field: 'pricingReadMbps', value: Number(e.target.value),
                })}
              />
              <div>
                <strong>読み出し帯域 (MB/s)</strong>
                <small>ここから出すときの速度。実測値を入れると所要時間の精度が上がります。</small>
              </div>
            </label>

            <label className="modal-choice">
              <input
                type="number"
                min={1}
                aria-label="書き込み帯域 (MB/s)"
                value={pricingWriteMbps}
                onChange={e => dispatch({
                  type: 'setField', field: 'pricingWriteMbps', value: Number(e.target.value),
                })}
              />
              <div>
                <strong>書き込み帯域 (MB/s)</strong>
                <small>ここへ入れるときの速度。両端の遅い方が律速になります。</small>
              </div>
            </label>

            <label className="modal-choice">
              <input
                type="number"
                min={0}
                step={0.1}
                aria-label="不安定さ"
                value={pricingInstability}
                onChange={e => dispatch({
                  type: 'setField', field: 'pricingInstability', value: Number(e.target.value),
                })}
              />
              <div>
                <strong>不安定さ</strong>
                <small>
                  所要時間の上振れ率。0.5 なら悲観側が 1.5 倍になります。
                  よく落ちる接続ほど大きく。
                </small>
              </div>
            </label>

            <label className="modal-choice">
              <input
                type="number"
                min={0}
                step={1}
                placeholder="未設定"
                aria-label="容量 (TB)"
                value={pricingCapacityTb}
                onChange={e => dispatch({
                  type: 'setField',
                  field: 'pricingCapacityTb',
                  value: e.target.value === '' ? '' : Number(e.target.value),
                })}
              />
              <div>
                <strong>容量 (TB)</strong>
                <small>入れておくと、収まらない移送に警告が出ます。空なら警告しません。</small>
              </div>
            </label>

            <label className="modal-choice">
              <input
                type="number"
                min={0}
                step={0.001}
                placeholder="カタログに従う"
                aria-label="ストレージ単価の上書き ($/GB-月)"
                value={pricingStoragePerGbMonth}
                onChange={e => dispatch({
                  type: 'setField',
                  field: 'pricingStoragePerGbMonth',
                  value: e.target.value === '' ? '' : Number(e.target.value),
                })}
              />
              <div>
                <strong>ストレージ単価の上書き ($/GB-月)</strong>
                <small>
                  実際の契約単価があれば入れてください。空ならカタログの値を使います。
                  Wasabi のように料金 API を公開していないプロバイダでは、
                  カタログの値は手入力なので、ここを入れたほうが正確です。
                </small>
              </div>
            </label>

            <small className="block text-ink-7">
              {current.pricing.ratesResolved ? (
                current.pricing.effective.storagePerGbMonth === null
                  ? '費用のかからない接続として計算します。'
                  : <>
                      現在の単価: ${current.pricing.effective.storagePerGbMonth}/GB-月 ·
                      PUT ${current.pricing.effective.putPer1000}/1000 ·
                      取り出し ${current.pricing.effective.retrievalPerGb}/GB
                      {current.pricing.effective.minDurationDays > 0
                        && ` · 最小保存 ${current.pricing.effective.minDurationDays} 日`}
                      {current.pricing.effective.storageRateSource === 'proxy'
                        && ' (ストレージ単価は代理値)'}
                      {current.pricing.effective.storageRateSource === 'manual'
                        && ' (単価は手入力。「単価を更新」では変わりません)'}
                      {current.pricing.effective.storageRateSource === 'override'
                        && ' (単価はこの接続で上書き済み)'}
                    </>
              ) : (
                `リージョン ${current.pricing.region ?? '(不明)'} の単価が料金カタログにありません。`
                + '費用は 0 と表示されますが、無料という意味ではありません。'
              )}
            </small>
          </fieldset>
        )}

        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={saving}>キャンセル</button>
          <button onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
  )

  return presentation === 'modal'
    ? <div className="modal-backdrop">{form}</div>
    : form
}
