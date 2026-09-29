import { CapacityOverview, CapacityPrefixHistory, CapacityScanResponse } from './types'
import { buildUrl, getJson, mutateJson, storagePath } from './http'

// 接続内の全バケットの容量メトリクス。計測はサーバーの scheduler が持つので TTLCache は通さない。
export const capacityClient = {
  capacityOverview: (connectionId: string, days: number) =>
    getJson(buildUrl(storagePath(connectionId, '/capacity'), { days: String(days) }), CapacityOverview),

  capacityPrefixHistory: ({ connectionId, bucket, prefix, days }: {
    connectionId: string
    bucket: string
    prefix: string
    days: number
  }) =>
    getJson(
      buildUrl(storagePath(connectionId, '/capacity/prefix'), { bucket, prefix, days: String(days) }),
      CapacityPrefixHistory,
    ),

  startCapacityScan: (connectionId: string) =>
    mutateJson(storagePath(connectionId, '/capacity/scan'), { method: 'POST' }, CapacityScanResponse),
}
