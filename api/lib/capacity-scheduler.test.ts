import { describe, expect, it, vi } from 'vitest'
import { createCapacityScheduler } from './capacity-scheduler.js'
import { scanDedupKey } from '../routes/storage-scan.js'

describe('capacity scheduler', () => {
  it('期限を迎えたconnectionの全bucketをroot走査へ投入する', async () => {
    const attachJob = vi.fn()
    const markConnectionScheduled = vi.fn()
    const enqueueWithResult = vi.fn()
      .mockResolvedValueOnce({ id: 9, created: true })
      .mockResolvedValueOnce({ id: 10, created: true })
    const scheduler = createCapacityScheduler({
      capacity: {
        reserveDueConnections: vi.fn().mockResolvedValue(['c1']),
        syncBuckets: vi.fn(), attachJob, markConnectionScheduled,
        markConnectionPaused: vi.fn(), recordConnectionError: vi.fn(),
      },
      jobs: { enqueueWithResult },
      getConnectionConfig: vi.fn().mockResolvedValue({ scanEnabled: true }),
      listBuckets: vi.fn().mockResolvedValue(['archive', 'data']),
    })
    expect(await scheduler.runOnce()).toBe(1)
    expect(enqueueWithResult).toHaveBeenNthCalledWith(
      1, 'storage.scan', scanDedupKey('c1', 'archive', ''),
      { connId: 'c1', bucket: 'archive', prefix: '' },
    )
    expect(enqueueWithResult).toHaveBeenNthCalledWith(
      2, 'storage.scan', scanDedupKey('c1', 'data', ''),
      { connId: 'c1', bucket: 'data', prefix: '' },
    )
    expect(attachJob).toHaveBeenCalledTimes(2)
    expect(markConnectionScheduled).toHaveBeenCalledWith('c1')
  })

  it('走査無効connectionはpausedにして投入しない', async () => {
    const markConnectionPaused = vi.fn()
    const enqueueWithResult = vi.fn()
    const scheduler = createCapacityScheduler({
      capacity: {
        reserveDueConnections: vi.fn().mockResolvedValue(['c1']),
        syncBuckets: vi.fn(), attachJob: vi.fn(), markConnectionScheduled: vi.fn(),
        markConnectionPaused, recordConnectionError: vi.fn(),
      },
      jobs: { enqueueWithResult },
      getConnectionConfig: vi.fn().mockResolvedValue({ scanEnabled: false }),
      listBuckets: vi.fn(),
    })
    await scheduler.runOnce()
    expect(markConnectionPaused).toHaveBeenCalledWith('c1')
    expect(enqueueWithResult).not.toHaveBeenCalled()
  })
})
