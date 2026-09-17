import { CapacityOverview, CapacityScanResponse } from './types'
import { buildUrl, getJson, mutateJson, storagePath } from './http'

// 接続内の全バケットの容量メトリクス。計測はサーバーの scheduler が持つので TTLCache は通さない。
export const capacityClient = {
  capacityOverview: (connectionId: string, days: number) =>
    getJson(buildUrl(storagePath(connectionId, '/capacity'), { days: String(days) }), CapacityOverview),

  startCapacityScan: (connectionId: string) =>
    mutateJson(storagePath(connectionId, '/capacity/scan'), { method: 'POST' }, CapacityScanResponse),
}
