import { describe, expect, it, vi } from 'vitest'
import { capacityMetricFamilies, createCapacityMetricsCollector } from './capacity-metrics.js'
import type { ConnectionCapacityTracking, LatestBucketCapacity } from './capacity-store.js'
import type { MetricFamily } from './metrics-collector.js'

const measured: LatestBucketCapacity = {
  connectionId: 'connection-a', bucket: 'dataset', consecutiveFailures: 2,
  totalBytes: '9007199254740993', objectCount: '547259',
  collectedAt: new Date('2026-09-23T00:00:00Z'),
}
const unmeasured: LatestBucketCapacity = {
  connectionId: 'connection-a', bucket: 'new', consecutiveFailures: 1,
  totalBytes: null, objectCount: null, collectedAt: null,
}
const tracked: ConnectionCapacityTracking = {
  connectionId: 'connection-a', connectionName: 'mdx s3', trackingEnabled: true, intervalSeconds: 21600,
}
const neverConfigured: ConnectionCapacityTracking = {
  connectionId: 'connection-b', connectionName: 'aws', trackingEnabled: false, intervalSeconds: null,
}

function family(families: MetricFamily[], name: string): MetricFamily {
  const found = families.find(candidate => candidate.name === name)
  if (!found) throw new Error(`${name} is missing`)
  return found
}

describe('capacityMetricFamilies', () => {
  const families = capacityMetricFamilies({
    buckets: [measured, unmeasured],
    connections: [tracked, neverConfigured],
    now: new Date('2026-09-23T00:01:00Z'),
  })

  it('計測済みbucketの容量とobject数をBIGINTの文字列のまま出す', () => {
    const labels = { connection_id: 'connection-a', bucket: 'dataset' }
    expect(family(families, 'mado_storage_bucket_bytes').samples)
      .toEqual([{ labels, value: '9007199254740993' }])
    expect(family(families, 'mado_storage_bucket_objects').samples)
      .toEqual([{ labels, value: '547259' }])
    expect(family(families, 'mado_storage_capacity_collection_age_seconds').samples)
      .toEqual([{ labels, value: 60 }])
  })

  it('未計測bucketは失敗回数だけを出す', () => {
    expect(family(families, 'mado_storage_capacity_collection_failures').samples).toEqual([
      { labels: { connection_id: 'connection-a', bucket: 'dataset' }, value: 2 },
      { labels: { connection_id: 'connection-a', bucket: 'new' }, value: 1 },
    ])
  })

  it('connectionごとに名前と定期計測の有効・周期を出し、未設定の周期は出さない', () => {
    expect(family(families, 'mado_storage_connection_info').samples).toEqual([
      { labels: { connection_id: 'connection-a', connection_name: 'mdx s3' }, value: 1 },
      { labels: { connection_id: 'connection-b', connection_name: 'aws' }, value: 1 },
    ])
    expect(family(families, 'mado_storage_capacity_tracking_enabled').samples).toEqual([
      { labels: { connection_id: 'connection-a' }, value: 1 },
      { labels: { connection_id: 'connection-b' }, value: 0 },
    ])
    expect(family(families, 'mado_storage_capacity_tracking_interval_seconds').samples).toEqual([
      { labels: { connection_id: 'connection-a' }, value: 21600 },
    ])
  })

  it('snapshotの時刻が現在より後でも経過秒を負にしない', () => {
    const future = capacityMetricFamilies({
      buckets: [measured], connections: [], now: new Date('2026-09-22T23:59:00Z'),
    })
    expect(family(future, 'mado_storage_capacity_collection_age_seconds').samples[0].value).toBe(0)
  })
})

describe('createCapacityMetricsCollector', () => {
  it('storeから最新値とconnection設定を読んでfamilyを組み立てる', async () => {
    const store = {
      listLatestBucketCapacity: vi.fn().mockResolvedValue([measured]),
      listConnectionTracking: vi.fn().mockResolvedValue([tracked]),
    }
    const collector = createCapacityMetricsCollector(store)
    expect(collector.name).toBe('capacity')
    const families = await collector.collect()
    expect(family(families, 'mado_storage_bucket_bytes').samples).toHaveLength(1)
    expect(store.listLatestBucketCapacity).toHaveBeenCalledOnce()
    expect(store.listConnectionTracking).toHaveBeenCalledOnce()
  })
})
