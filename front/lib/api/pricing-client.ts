import { StartJobOk, TransferEstimate } from './types'
import { API_BASE, buildUrl, errorFromResponse, mutateJson, storagePath } from './http'

// 転送見積もり (spec: 2026-08-22-transfer-estimate-design.md)。
// 走査結果と接続設定だけから計算されるので S3 は叩かれない。
// 接続設定を変えると結果が変わるため TTLCache は通さない。
export const pricingClient = {
  /** 料金カタログの更新ジョブを投入する。**取得の完了は待たない** —
   *  呼び出し側が getJob でポーリングする。 */
  refreshPricing: () => mutateJson(`${API_BASE}/pricing/refresh`, { method: 'POST' }, StartJobOk),

  /** 走査済みディレクトリの移送見積もり。**まだ走査していなければ null**。 */
  estimate: async (connectionId: string, bucket: string, prefix: string) => {
    const res = await fetch(
      buildUrl(storagePath(connectionId, '/estimate'), { bucket, prefix }),
      { headers: { Accept: 'application/json' } },
    )
    if (res.status === 409) return null
    if (!res.ok) throw await errorFromResponse(res)
    return TransferEstimate.parse(await res.json())
  },
}
