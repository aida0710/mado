import type { CapacityStore, ConnectionCapacityTracking, LatestBucketCapacity } from './capacity-store.js'
import type { MetricFamily, MetricSample, MetricsCollector } from './metrics-collector.js'

type MeasuredBucketCapacity = LatestBucketCapacity & {
  totalBytes: string
  objectCount: string
  collectedAt: Date
}

function isMeasured(bucket: LatestBucketCapacity): bucket is MeasuredBucketCapacity {
  return bucket.totalBytes !== null && bucket.objectCount !== null && bucket.collectedAt !== null
}

function gauge(name: string, help: string, samples: MetricSample[]): MetricFamily {
  return { name, help, type: 'gauge', samples }
}

function bucketLabels(bucket: LatestBucketCapacity): Record<string, string> {
  return { connection_id: bucket.connectionId, bucket: bucket.bucket }
}

export interface CapacityMetricsInput {
  buckets: LatestBucketCapacity[]
  connections: ConnectionCapacityTracking[]
  now: Date
}

/**
 * 保存済みの最新値だけを出す。scrapeで走査は始めない。
 * 未計測bucketは容量・object数・経過秒を出さず、失敗回数だけを出す。
 */
export function capacityMetricFamilies({ buckets, connections, now }: CapacityMetricsInput): MetricFamily[] {
  const measured = buckets.filter(isMeasured)
  return [
    // connection_idはnanoidなので、Grafanaで名前を引けるよう値1のinfo metricを添える。
    gauge('mado_storage_connection_info', 'Storage connection name. Always 1.',
      connections.map(connection => ({
        labels: { connection_id: connection.connectionId, connection_name: connection.connectionName },
        value: 1,
      }))),
    // 定期計測を止めたconnectionでage alertを鳴らさないための条件に使う。
    gauge('mado_storage_capacity_tracking_enabled', 'Whether scheduled capacity tracking is enabled (1) or not (0).',
      connections.map(connection => ({
        labels: { connection_id: connection.connectionId },
        value: connection.trackingEnabled ? 1 : 0,
      }))),
    gauge('mado_storage_capacity_tracking_interval_seconds', 'Configured interval of scheduled capacity tracking.',
      connections.flatMap(connection => connection.intervalSeconds === null ? [] : [{
        labels: { connection_id: connection.connectionId },
        value: connection.intervalSeconds,
      }])),
    gauge('mado_storage_bucket_bytes', 'Latest measured bucket size in bytes.',
      measured.map(bucket => ({ labels: bucketLabels(bucket), value: bucket.totalBytes }))),
    gauge('mado_storage_bucket_objects', 'Latest measured bucket object count.',
      measured.map(bucket => ({ labels: bucketLabels(bucket), value: bucket.objectCount }))),
    gauge('mado_storage_capacity_collection_age_seconds', 'Seconds since the latest successful bucket scan.',
      measured.map(bucket => ({
        labels: bucketLabels(bucket),
        value: Math.max(0, (now.getTime() - bucket.collectedAt.getTime()) / 1000),
      }))),
    gauge('mado_storage_capacity_collection_failures', 'Consecutive failed bucket scans.',
      buckets.map(bucket => ({ labels: bucketLabels(bucket), value: bucket.consecutiveFailures }))),
  ]
}

export function createCapacityMetricsCollector(
  store: Pick<CapacityStore, 'listLatestBucketCapacity' | 'listConnectionTracking'>,
): MetricsCollector {
  return {
    name: 'capacity',
    async collect() {
      const [buckets, connections] = await Promise.all([
        store.listLatestBucketCapacity(),
        store.listConnectionTracking(),
      ])
      return capacityMetricFamilies({ buckets, connections, now: new Date() })
    },
  }
}
