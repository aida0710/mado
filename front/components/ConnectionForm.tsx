import { useEffect, useId, useReducer, useState, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { CAPABILITY_UI, PROVIDER_LABELS, STORAGE_CLASS_OPTIONS } from '../lib/api/types'
import { api } from '../lib/api/client'
import type {
  Connection,
  ConnectionAccessUser,
  ConnectionCreateInput,
  ConnectionUpdateInput,
  Provider,
  StorageClassKey,
} from '../lib/api/types'
import {
  initialState, reducer, toCreateInput, toUpdateInput, validateForm, type FormState,
} from '../lib/connectionFormState'
import { Dialog } from './Dialog'

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
  /** page = 設定の中に一つの画面として出す。modal = ダイアログに重ねて出す。 */
  presentation?: 'modal' | 'page'
}

/** 説明つきの選択肢の一行。チェックボックス・ラジオは左、文言は右。 */
function Choice({ control, title, help }: { control: ReactNode; title: ReactNode; help?: ReactNode }) {
  return (
    <label className="choice">
      {control}
      <span>
        <strong>{title}</strong>
        {help && <small>{help}</small>}
      </span>
    </label>
  )
}

/** 値を選ぶ・入れる設定の一行。文言は左、選択肢や数値の欄は右 (狭い画面では下)。 */
function ValueChoice({ control, title, help }: { control: ReactNode; title: ReactNode; help?: ReactNode }) {
  return (
    <label className="choice choice--value">
      <span>
        <strong>{title}</strong>
        {help && <small>{help}</small>}
      </span>
      {control}
    </label>
  )
}

export function ConnectionForm({ mode, onClose, presentation = 'modal' }: Props) {
  const isEdit = mode.kind === 'edit'
  const current = mode.kind === 'edit' ? mode.current : null
  const ids = useId()

  const [state, dispatch] = useReducer(reducer, current, initialState)
  const [accessUsers, setAccessUsers] = useState<ConnectionAccessUser[]>([])
  const [accessUsersError, setAccessUsersError] = useState<string | null>(null)
  const {
    name, endpoint, region, accessKeyId, secretAccessKey,
    forcePathStyle, listObjectsVersion, capabilities, showSecret, saving, error,
    visibilityMode, allowedUserIds,
    scanEnabled,
    scanPageSize,
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
  const title = isEdit ? '接続を編集' : '接続を追加'

  const submit = async () => {
    const clientError = validateForm(state, isEdit)
    if (clientError) {
      dispatch({ type: 'setError', error: clientError })
      return
    }

    dispatch({ type: 'startSave' })
    try {
      if (mode.kind === 'create') await mode.onSubmit(toCreateInput(state))
      else await mode.onSubmit(toUpdateInput(state, mode.current))
      dispatch({ type: 'saveDone' })
    } catch (e) {
      dispatch({ type: 'saveFailed', error: (e as Error).message })
    }
  }

  const accessKeyPlaceholder = isEdit && current
    ? `${current.accessKeyIdMasked} — 空のままで変更しない`
    : ''
  const secretPlaceholder = isEdit ? '空のままで変更しない' : ''

  const fields = (
    <>
      <h3 className="form-section-heading">基本情報</h3>
      <label className="field">
        <span>名前</span>
        <input
          value={name}
          onChange={e => dispatch({ type: 'setField', field: 'name', value: e.target.value })}
          placeholder="例: production"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>エンドポイント</span>
        <input
          type="url"
          value={endpoint}
          onChange={e => dispatch({ type: 'setField', field: 'endpoint', value: e.target.value })}
          placeholder="https://s3.example.com"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>リージョン</span>
        <input
          value={region}
          onChange={e => dispatch({ type: 'setField', field: 'region', value: e.target.value })}
          placeholder="auto"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <h3 className="form-section-heading">認証情報</h3>
      <label className="field">
        <span>アクセスキー ID</span>
        <input
          value={accessKeyId}
          onChange={e => dispatch({ type: 'setField', field: 'accessKeyId', value: e.target.value })}
          placeholder={accessKeyPlaceholder}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="field">
        <label htmlFor={`${ids}-secret`}>シークレットアクセスキー</label>
        <div className="input-with-button">
          <input
            id={`${ids}-secret`}
            type={showSecret ? 'text' : 'password'}
            value={secretAccessKey}
            onChange={e => dispatch({ type: 'setField', field: 'secretAccessKey', value: e.target.value })}
            placeholder={secretPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="button"
            onClick={() => dispatch({ type: 'setField', field: 'showSecret', value: !showSecret })}
            aria-label={showSecret ? 'シークレットを隠す' : 'シークレットを表示'}
          >
            {showSecret ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
            {showSecret ? '隠す' : '表示'}
          </button>
        </div>
      </div>

      <fieldset className="choice-group">
        <legend>ユーザーからの表示</legend>
        <p className="muted">
          通常は全員に表示します。ホワイトリストでは、選択したユーザーと接続管理者だけが利用できます。
          許可されていないユーザーには接続自体が表示されず、URLを直接開いても404になります。
        </p>
        <div className="choice-list">
          <Choice
            control={
              <input
                type="radio"
                name="visibilityMode"
                aria-label="全員に表示"
                checked={visibilityMode === 'public'}
                onChange={() => dispatch({ type: 'setField', field: 'visibilityMode', value: 'public' })}
              />
            }
            title="全員に表示"
            help="既定。ログインできる全ユーザーがこの接続を利用できます。"
          />
          <Choice
            control={
              <input
                type="radio"
                name="visibilityMode"
                aria-label="ホワイトリスト"
                checked={visibilityMode === 'whitelist'}
                onChange={() => dispatch({ type: 'setField', field: 'visibilityMode', value: 'whitelist' })}
              />
            }
            title="ホワイトリスト"
            help="下で選択したユーザーだけに表示します。接続管理者は常にアクセスできます。"
          />
        </div>
        {visibilityMode === 'whitelist' && (
          <div className="choice-users" role="group" aria-label="接続を許可するユーザー">
            {accessUsersError && <p className="notice error" role="alert">{accessUsersError}</p>}
            {!accessUsersError && accessUsers.length === 0 && (
              <p className="muted">選択できるユーザーがいません。接続管理者だけが利用できます。</p>
            )}
            {accessUsers.length > 0 && (
              <div className="choice-list">
                {accessUsers.map(user => (
                  <Choice
                    key={user.id}
                    control={
                      <input
                        type="checkbox"
                        aria-label={`${user.displayName}を許可`}
                        checked={allowedUserIds.includes(user.id)}
                        onChange={event => dispatch({
                          type: 'toggleAllowedUser', userId: user.id, value: event.target.checked,
                        })}
                      />
                    }
                    title={<>{user.displayName}{user.status === 'disabled' ? '（無効）' : ''}</>}
                    help={user.username ?? user.email ?? user.id}
                  />
                ))}
              </div>
            )}
            {allowedUserIds.length === 0 && (
              <p className="muted">誰も選択しない場合、接続管理者だけが利用できます。</p>
            )}
          </div>
        )}
      </fieldset>

      <h3 className="form-section-heading">互換性</h3>
      {/* Path-style URL: 単一の選択肢として ListObjects と同じ構造で扱う。 */}
      <fieldset className="choice-group">
        <legend>Path-style URL</legend>
        <div className="choice-list">
          <Choice
            control={
              <input
                type="checkbox"
                aria-label="Path-style URL を使用する"
                checked={forcePathStyle}
                onChange={e => dispatch({ type: 'setField', field: 'forcePathStyle', value: e.target.checked })}
              />
            }
            title="Path-style URL を使用する"
            help={
              <>
                MinIO や自前の S3 互換サーバはこれを ON にしないと動かないことが
                多いです。AWS S3 / Cloudflare R2 などはどちらでも OK。迷ったら
                ON のままで大丈夫。
              </>
            }
          />
        </div>
      </fieldset>

      {/* ListObjects API バージョン: V2 を理解しないサーバ
          (V1 only の S3 互換実装) は v1 を選ぶ。 */}
      <fieldset className="choice-group">
        <legend>ListObjects API バージョン</legend>
        <div className="choice-list">
          <Choice
            control={
              <input
                type="radio"
                name="listObjectsVersion"
                value="v2"
                aria-label="ListObjects v2"
                checked={listObjectsVersion === 'v2'}
                onChange={() => dispatch({ type: 'setField', field: 'listObjectsVersion', value: 'v2' })}
              />
            }
            title="v2"
            help="AWS S3 / Cloudflare R2 / MinIO など、新しい実装向け (既定)。"
          />
          <Choice
            control={
              <input
                type="radio"
                name="listObjectsVersion"
                value="v1"
                aria-label="ListObjects v1"
                checked={listObjectsVersion === 'v1'}
                onChange={() => dispatch({ type: 'setField', field: 'listObjectsVersion', value: 'v1' })}
              />
            }
            title="v1"
            help={
              <>
                ListObjectsV2 を理解しない古い S3 互換実装、
                V2 を理解しないサーバ向け (ページが進まないときに切り替え)。
              </>
            }
          />
        </div>
      </fieldset>

      {/* 接続ごとの権限。認証のあるツールではないのでアクセス制御ではなく
          誤操作の防止 — Deep Archive のように「一覧は見たいが本体には触りたく
          ない」接続で危険な導線を閉じるためのもの。UI で隠すだけでなく API 側も
          403 で止める。 */}
      <h3 id={`${ids}-capabilities`} className="form-section-heading">この接続で許可する操作</h3>
      <fieldset className="choice-group" aria-labelledby={`${ids}-capabilities`}>
        <p className="muted">
          オフにすると画面から導線が消え、共有 URL を直接開いても 403 になります。
          既定はすべて許可です。
        </p>
        <div className="choice-list">
          {CAPABILITY_UI.map(({ key, label, help }) => (
            <Choice
              key={key}
              control={
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={capabilities[key]}
                  // README 編集は読み込みが前提 (API も 400 で弾く)。
                  disabled={key === 'readmeWrite' && !capabilities.readmeRead}
                  onChange={e => dispatch({ type: 'toggleCapability', cap: key, value: e.target.checked })}
                />
              }
              title={label}
              help={help}
            />
          ))}
        </div>
      </fieldset>

      <h3 id={`${ids}-behavior`} className="form-section-heading">この接続の動作</h3>
      <fieldset className="choice-group" aria-labelledby={`${ids}-behavior`}>
        <div className="choice-list">
          <Choice
            control={
              <input
                type="checkbox"
                aria-label="配下の走査を許可する"
                checked={scanEnabled}
                onChange={e => dispatch({ type: 'setField', field: 'scanEnabled', value: e.target.checked })}
              />
            }
            title="配下の走査を許可する"
            help={
              <>
                ディレクトリ配下のオブジェクト数・サイズを数えます。54 万キー規模の
                バケットでは数分かかるので、走らせたくない接続ではオフに。
              </>
            }
          />
          {isEdit && (
            <ValueChoice
              control={
                <select
                  aria-label="走査のページサイズ"
                  value={scanPageSize}
                  disabled={!scanEnabled}
                  onChange={e => dispatch({
                    type: 'setField', field: 'scanPageSize', value: Number(e.target.value) as FormState['scanPageSize'],
                  })}
                >
                  <option value={100}>100件</option>
                  <option value={250}>250件</option>
                  <option value={500}>500件</option>
                  <option value={1000}>1,000件</option>
                </select>
              }
              title="走査のページサイズ"
              help="1回のS3一覧取得件数。既定は1,000件。応答が遅い接続では小さくします。"
            />
          )}
          {isEdit && (
            <Choice
              control={
                <input
                  type="checkbox"
                  aria-label="バケットのメトリクス集計を許可する"
                  checked={capacityMetricsEnabled}
                  disabled={!scanEnabled}
                  onChange={e => dispatch({ type: 'setField', field: 'capacityMetricsEnabled', value: e.target.checked })}
                />
              }
              title="バケットのメトリクス集計を許可する"
              help="全バケットの容量とオブジェクト数を集計する操作を許可します。"
            />
          )}
          {isEdit && (
            <Choice
              control={
                <input
                  type="checkbox"
                  aria-label="全バケットの容量を定期計測する"
                  checked={capacityTrackingEnabled}
                  disabled={!scanEnabled || !capacityMetricsEnabled}
                  onChange={e => dispatch({ type: 'setField', field: 'capacityTrackingEnabled', value: e.target.checked })}
                />
              }
              title="全バケットの容量を定期計測する"
              help="このコネクションにある全バケットの容量とオブジェクト数を記録します。"
            />
          )}
          {isEdit && (
            <ValueChoice
              control={
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
              }
              title="容量の計測周期"
              help="既定は24時間。すべてのバケットへ同じ周期を適用します。"
            />
          )}
          <ValueChoice
            control={
              <input
                type="number"
                min={1}
                aria-label="一覧キャッシュの保持秒数"
                value={listCacheTtlSec}
                onChange={e => dispatch({
                  type: 'setField', field: 'listCacheTtlSec', value: Number(e.target.value),
                })}
              />
            }
            title="一覧キャッシュの保持 (秒)"
            help={
              <>
                既定 86400 (24 時間)。この接続の一覧をサーバー側で何秒保持するか。
                更新が激しい接続は短くします。
              </>
            }
          />
        </div>
      </fieldset>

      {/* 転送見積もりのプロファイル (spec: 2026-08-22-transfer-estimate-design.md)。
          作成時は出さない — 既定 (エンドポイントからの推定) で見積もりは出るので、
          接続を足す時点で決めさせる必要が無い。 */}
      {isEdit && current && (
        <>
          <h3 id={`${ids}-pricing`} className="form-section-heading">転送の見積もり</h3>
          <fieldset className="choice-group" aria-labelledby={`${ids}-pricing`}>
            <p className="muted">
              「配下の集計 → 移送の見積もり」で使う値です。触らなくても見積もりは出ます。
            </p>
            <div className="choice-list">
              <ValueChoice
                control={
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
                }
                title="プロバイダ"
                help={
                  <>
                    料金の計算方法。既定はエンドポイントのホスト名からの推定で、
                    社内ストレージは費用 0 として扱います。
                  </>
                }
              />

              {(pricingProvider || current.pricing.provider) === 'aws' && (
                <ValueChoice
                  control={
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
                  }
                  title="ストレージクラス"
                  help={STORAGE_CLASS_OPTIONS.find(o => o.key === pricingStorageClass)?.help}
                />
              )}

              <ValueChoice
                control={
                  <input
                    type="number"
                    min={1}
                    aria-label="読み出し帯域 (MB/s)"
                    value={pricingReadMbps}
                    onChange={e => dispatch({
                      type: 'setField', field: 'pricingReadMbps', value: Number(e.target.value),
                    })}
                  />
                }
                title="読み出し帯域 (MB/s)"
                help="ここから出すときの速度。実測値を入れると所要時間の精度が上がります。"
              />

              <ValueChoice
                control={
                  <input
                    type="number"
                    min={1}
                    aria-label="書き込み帯域 (MB/s)"
                    value={pricingWriteMbps}
                    onChange={e => dispatch({
                      type: 'setField', field: 'pricingWriteMbps', value: Number(e.target.value),
                    })}
                  />
                }
                title="書き込み帯域 (MB/s)"
                help="ここへ入れるときの速度。両端の遅い方が律速になります。"
              />

              <ValueChoice
                control={
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
                }
                title="不安定さ"
                help={
                  <>
                    所要時間の上振れ率。0.5 なら悲観側が 1.5 倍になります。
                    よく落ちる接続ほど大きく。
                  </>
                }
              />

              <ValueChoice
                control={
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
                }
                title="容量 (TB)"
                help="入れておくと、収まらない移送に警告が出ます。空なら警告しません。"
              />

              <ValueChoice
                control={
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
                }
                title="ストレージ単価の上書き ($/GB-月)"
                help={
                  <>
                    実際の契約単価があれば入れてください。空ならカタログの値を使います。
                    Wasabi のように料金 API を公開していないプロバイダでは、
                    カタログの値は手入力なので、ここを入れたほうが正確です。
                  </>
                }
              />
            </div>

            <p className="muted choice-group__note">
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
            </p>
          </fieldset>
        </>
      )}

      {error && <p className="notice error" aria-live="polite">{error}</p>}
    </>
  )

  const actions = (
    <>
      <button type="button" className="button" onClick={onClose} disabled={saving}>キャンセル</button>
      <button type="button" className="button primary" onClick={() => void submit()} disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </button>
    </>
  )

  if (presentation === 'page') {
    return (
      <section className="connection-form" aria-labelledby={titleId}>
        <div className="section-heading">
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="connection-form__body">{fields}</div>
        <div className="connection-form__actions">{actions}</div>
      </section>
    )
  }

  return (
    <Dialog
      titleId={titleId}
      title={title}
      onClose={onClose}
      dismissible={!saving}
      size="wide"
      footer={actions}
    >
      <div className="dialog-body connection-form__body">{fields}</div>
    </Dialog>
  )
}
