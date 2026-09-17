import { ALL_CAPABILITIES_ON, CAPABILITY_UI } from './api/types'
import type {
  Capabilities,
  Capability,
  Connection,
  ConnectionCreateInput,
  ConnectionPricingInput,
  ConnectionUpdateInput,
  ListObjectsVersion,
  Provider,
  StorageClassKey,
} from './api/types'

// 接続フォームの状態と、それを API の入力へ変換する純粋ロジック。
// 画面 (ConnectionForm) はここを呼ぶだけで、差分の計算をしない。

/** 容量の入力単位。fmtSize が 1024 系なので、表示と揃えて TiB で扱う。 */
export const TIB = 1024 ** 4

export interface FormState {
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
  scanPageSize: 100 | 250 | 500 | 1000
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

export type FieldName = Exclude<keyof FormState, 'saving' | 'error' | 'capabilities' | 'allowedUserIds'>

export type Action =
  | { type: 'setField'; field: FieldName; value: FormState[FieldName] }
  | { type: 'toggleCapability'; cap: Capability; value: boolean }
  | { type: 'toggleAllowedUser'; userId: string; value: boolean }
  | { type: 'startSave' }
  | { type: 'saveFailed'; error: string }
  | { type: 'saveDone' }
  | { type: 'setError'; error: string | null }

export function reducer(state: FormState, action: Action): FormState {
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

export function initialState(current: Connection | null): FormState {
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
    scanPageSize: current?.scanPageSize ?? 1000,
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

/** 送信前に画面側で弾く不足項目。null なら送ってよい。 */
export function validateForm(state: FormState, isEdit: boolean): string | null {
  if (!state.name.trim()) return '名前を入力してください'
  if (!state.endpoint.trim()) return 'エンドポイントを入力してください'
  if (!state.region.trim()) return 'リージョンを入力してください'
  if (!isEdit) {
    if (!state.accessKeyId.trim()) return 'アクセスキー ID を入力してください'
    if (!state.secretAccessKey) return 'シークレットアクセスキーを入力してください'
  }
  return null
}

export function toCreateInput(state: FormState): ConnectionCreateInput {
  return {
    name: state.name.trim(),
    endpoint: state.endpoint.trim(),
    region: state.region.trim(),
    accessKeyId: state.accessKeyId.trim(),
    secretAccessKey: state.secretAccessKey,
    forcePathStyle: state.forcePathStyle,
    listObjectsVersion: state.listObjectsVersion,
    capabilities: state.capabilities,
    visibility: { mode: state.visibilityMode, allowedUserIds: state.allowedUserIds },
  }
}

/** 現在の接続と比べて変わった項目だけを入れた更新入力。何も変わっていなければ {}。 */
export function toUpdateInput(state: FormState, current: Connection): ConnectionUpdateInput {
  const {
    name, endpoint, region, accessKeyId, secretAccessKey,
    forcePathStyle, listObjectsVersion, capabilities, visibilityMode, allowedUserIds,
    scanEnabled, scanPageSize, capacityMetricsEnabled, listCacheTtlSec,
    capacityTrackingEnabled, capacityTrackingIntervalSeconds,
    pricingProvider, pricingStorageClass, pricingReadMbps, pricingWriteMbps,
    pricingCapacityTb, pricingInstability, pricingStoragePerGbMonth,
  } = state
  const input: ConnectionUpdateInput = {}
  if (name.trim() !== current.name) input.name = name.trim()
  if (endpoint.trim() !== current.endpoint) input.endpoint = endpoint.trim()
  if (region.trim() !== current.region) input.region = region.trim()
  if (forcePathStyle !== current.forcePathStyle) input.forcePathStyle = forcePathStyle
  if (listObjectsVersion !== current.listObjectsVersion) input.listObjectsVersion = listObjectsVersion
  // 権限も差分。変えたトグルだけ送る (API 側も差分更新)。
  const capabilityChanges: Partial<Capabilities> = {}
  for (const { key } of CAPABILITY_UI) {
    if (capabilities[key] !== current.capabilities[key]) capabilityChanges[key] = capabilities[key]
  }
  if (Object.keys(capabilityChanges).length > 0) input.capabilities = capabilityChanges
  const currentAllowedUserIds = current.visibility.allowedUsers.map(user => user.id).sort()
  const allowedUsersChanged = allowedUserIds.length !== currentAllowedUserIds.length
    || allowedUserIds.some((id, index) => id !== currentAllowedUserIds[index])
  if (visibilityMode !== current.visibility.mode || allowedUsersChanged) {
    input.visibility = { mode: visibilityMode, allowedUserIds }
  }
  if (scanEnabled !== current.scanEnabled) input.scanEnabled = scanEnabled
  if (scanPageSize !== (current.scanPageSize ?? 1000)) input.scanPageSize = scanPageSize
  if (capacityMetricsEnabled !== (current.capacityMetricsEnabled ?? true)) {
    input.capacityMetricsEnabled = capacityMetricsEnabled
  }
  if (listCacheTtlSec !== current.listCacheTtlSec) input.listCacheTtlSec = listCacheTtlSec
  const currentCapacityTracking = current.capacityTracking ?? { enabled: false, intervalSeconds: 86400 }
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
  const currentPricing = current.pricing
  const pricing: ConnectionPricingInput = {}
  const wantProvider = pricingProvider === '' ? null : pricingProvider
  if (wantProvider !== (currentPricing.providerExplicit ? currentPricing.provider : null)) {
    pricing.provider = wantProvider
  }
  if (pricingStorageClass !== (currentPricing.storageClass ?? 'STANDARD')) {
    pricing.storageClass = pricingStorageClass
  }
  if (pricingReadMbps !== currentPricing.readMbps) pricing.readMbps = pricingReadMbps
  if (pricingWriteMbps !== currentPricing.writeMbps) pricing.writeMbps = pricingWriteMbps
  if (pricingInstability !== currentPricing.instability) pricing.instability = pricingInstability
  const wantCapacity = pricingCapacityTb === '' ? null : Math.round(pricingCapacityTb * TIB)
  if (wantCapacity !== currentPricing.capacityBytes) pricing.capacityBytes = wantCapacity
  const wantRate = pricingStoragePerGbMonth === '' ? null : pricingStoragePerGbMonth
  if (wantRate !== currentPricing.storagePerGbMonth) pricing.storagePerGbMonth = wantRate
  if (Object.keys(pricing).length > 0) input.pricing = pricing

  if (accessKeyId.trim()) input.accessKeyId = accessKeyId.trim()
  if (secretAccessKey) input.secretAccessKey = secretAccessKey
  return input
}
