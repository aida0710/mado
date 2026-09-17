import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createScanHandler } from './scan-handler.js'
import type { JobContext } from './job-runner.js'
import type { ScanResult } from './scan.js'
import type { ConnectionConfig } from '../storage.js'

const storageMock = mockClient(S3Client)
const storage = new S3Client({})
const config = {
  listObjectsVersion: 'v2', capabilities: {}, scanEnabled: true,
  scanPageSize: 1000, capacityMetricsEnabled: true, listCacheTtlSec: 86400,
} as unknown as ConnectionConfig
const deps = {
  getStorage: async (): Promise<S3Client> => storage,
  getConnectionConfig: async (): Promise<ConnectionConfig> => config,
}

function ctx(payload: unknown, signal = new AbortController().signal): JobContext {
  return { jobId: 1, payload, signal, setProgress: () => {} }
}

beforeEach(() => storageMock.reset())

describe('createScanHandler', () => {
  it('複数ページを集計する', async () => {
    storageMock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'd/a.tar', Size: 100 }],
        IsTruncated: true, NextContinuationToken: 'tok',
      })
      .resolvesOnce({ Contents: [{ Key: 'd/b.tar', Size: 200 }], IsTruncated: false })

    const handler = createScanHandler(deps)
    const r = await handler(ctx({ connectionId: 'c1', bucket: 'b', prefix: 'd/' })) as ScanResult
    expect(r.objectCount).toBe(2)
    expect(r.totalBytes).toBe(300)
    expect(r.partial).toBe(false)
    expect(storageMock.calls()).toHaveLength(2)
  })

  it('Delimiter を送らない (フラット列挙)', async () => {
    storageMock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false })
    const handler = createScanHandler(deps)
    await handler(ctx({ connectionId: 'c1', bucket: 'b', prefix: '' }))
    const input = storageMock.calls()[0].args[0].input as { Delimiter?: string; MaxKeys?: number }
    expect(input.Delimiter).toBeUndefined()
    expect(input.MaxKeys).toBe(1000)
  })

  it('connectionで指定したページサイズをV2走査へ適用する', async () => {
    storageMock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false })
    const handler = createScanHandler({
      ...deps,
      getConnectionConfig: async () => ({ ...config, scanPageSize: 100 }),
    })
    await handler(ctx({ connectionId: 'c1', bucket: 'b', prefix: '' }))
    expect(storageMock.calls()[0].args[0].input).toMatchObject({ MaxKeys: 100 })
  })

  // 数十万キー数えた後に 1 ページ失敗して全部捨てるのは損。
  it('途中で S3 が失敗したら partial で返す', async () => {
    storageMock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'd/a.tar', Size: 100 }],
        IsTruncated: true, NextContinuationToken: 'tok',
      })
      .rejectsOnce(new Error('boom'))

    const handler = createScanHandler(deps)
    const r = await handler(ctx({ connectionId: 'c1', bucket: 'b', prefix: 'd/' })) as ScanResult
    expect(r.objectCount).toBe(1)
    expect(r.partial).toBe(true)
  })

  it('signal が abort されたらページングを止める', async () => {
    const ac = new AbortController()
    storageMock.on(ListObjectsV2Command).callsFake(() => {
      ac.abort()
      return { Contents: [{ Key: 'd/a.tar', Size: 1 }], IsTruncated: true, NextContinuationToken: 'tok' }
    })
    const handler = createScanHandler(deps)
    const r = await handler(ctx({ connectionId: 'c1', bucket: 'b', prefix: 'd/' }, ac.signal)) as ScanResult
    expect(storageMock.calls()).toHaveLength(1)
    expect(r.objectCount).toBe(1)
  })

  it('payload が不正なら throw する', async () => {
    const handler = createScanHandler(deps)
    await expect(handler(ctx({ connectionId: 'c1' }))).rejects.toThrow()
  })

  it('バケットrootの完全走査だけを容量履歴へ保存する', async () => {
    storageMock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'a.tar', Size: 123 }], IsTruncated: false,
    })
    const recordSuccess = vi.fn()
    const handler = createScanHandler({
      ...deps,
      capacity: { recordSuccess, recordPartial: vi.fn(), recordError: vi.fn() },
    })
    await handler({ ...ctx({ connectionId: 'c1', bucket: 'b', prefix: '' }), jobId: 81 })
    expect(recordSuccess).toHaveBeenCalledWith({
      jobId: 81, connectionId: 'c1', bucket: 'b',
      result: expect.objectContaining({ totalBytes: 123, objectCount: 1 }),
    })

    await handler({ ...ctx({ connectionId: 'c1', bucket: 'b', prefix: 'dir/' }), jobId: 82 })
    expect(recordSuccess).toHaveBeenCalledTimes(1)
  })

  it('partialなroot走査は履歴へ保存しない', async () => {
    storageMock.on(ListObjectsV2Command).rejects(new Error('boom'))
    const recordSuccess = vi.fn()
    const recordPartial = vi.fn()
    const handler = createScanHandler({
      ...deps,
      capacity: { recordSuccess, recordPartial, recordError: vi.fn() },
    })
    await handler(ctx({ connectionId: 'c1', bucket: 'b', prefix: '' }))
    expect(recordSuccess).not.toHaveBeenCalled()
    expect(recordPartial).toHaveBeenCalledWith('c1', 'b')
  })
})
