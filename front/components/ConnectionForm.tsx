import { useEffect, useReducer, useState } from 'react'
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
            <label className={`modal-choice ${!scanEnabled ? 'opacity-50' : ''}`}>
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
              <div>
                <strong>走査のページサイズ</strong>
                <small>1回のS3一覧取得件数。既定は1,000件。応答が遅い接続では小さくします。</small>
              </div>
            </label>
          )}
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
