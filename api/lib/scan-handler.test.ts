import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import { createScanHandler } from './scan-handler.js'
import type { JobContext } from './job-runner.js'
import type { ScanResult } from './scan.js'
import type { ConnectionConfig } from '../storage.js'

const storageMock = mockClient(S3Client)
const storage = new S3Client({})
const config = { listObjectsVersion: 'v2' } as ConnectionConfig
const deps = {
  getStorage: async (): Promise<S3Client> => storage,
  getConnectionConfig: async (): Promise<ConnectionConfig> => config,
}

function ctx(payload: unknown, signal = new AbortController().signal): JobContext {
  return { payload, signal, setProgress: () => {} }
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
    const r = await handler(ctx({ connId: 'c1', bucket: 'b', prefix: 'd/' })) as ScanResult
    expect(r.objectCount).toBe(2)
    expect(r.totalBytes).toBe(300)
    expect(r.partial).toBe(false)
    expect(storageMock.calls()).toHaveLength(2)
  })

  it('Delimiter を送らない (フラット列挙)', async () => {
    storageMock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false })
    const handler = createScanHandler(deps)
    await handler(ctx({ connId: 'c1', bucket: 'b', prefix: '' }))
    const input = storageMock.calls()[0].args[0].input as { Delimiter?: string; MaxKeys?: number }
    expect(input.Delimiter).toBeUndefined()
    expect(input.MaxKeys).toBe(1000)
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
    const r = await handler(ctx({ connId: 'c1', bucket: 'b', prefix: 'd/' })) as ScanResult
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
    const r = await handler(ctx({ connId: 'c1', bucket: 'b', prefix: 'd/' }, ac.signal)) as ScanResult
    expect(storageMock.calls()).toHaveLength(1)
    expect(r.objectCount).toBe(1)
  })

  it('payload が不正なら throw する', async () => {
    const handler = createScanHandler(deps)
    await expect(handler(ctx({ connId: 'c1' }))).rejects.toThrow()
  })
})
