import { describe, expect, it, vi } from 'vitest'
import { createCapacityScheduler } from './capacity-scheduler.js'
import { scanDedupKey } from '../routes/storage-scan.js'

describe('capacity scheduler', () => {
  it('期限を迎えた対象をroot走査へ投入する', async () => {
    const attachJob = vi.fn()
    const enqueueWithResult = vi.fn().mockResolvedValue({ id: 9, created: true })
    const scheduler = createCapacityScheduler({
      capacity: {
        reserveDue: vi.fn().mockResolvedValue([{ connectionId: 'c1', bucket: 'data' }]),
        attachJob,
        markPaused: vi.fn(), recordError: vi.fn(),
      },
      jobs: { enqueueWithResult },
      getConnectionConfig: vi.fn().mockResolvedValue({ scanEnabled: true }),
    })
    expect(await scheduler.runOnce()).toBe(1)
    expect(enqueueWithResult).toHaveBeenCalledWith('storage.scan', scanDedupKey('c1', 'data', ''), {
      connId: 'c1', bucket: 'data', prefix: '',
    })
    expect(attachJob).toHaveBeenCalledWith('c1', 'data', 9)
  })

  it('走査無効接続はpausedにして投入しない', async () => {
    const markPaused = vi.fn()
    const enqueueWithResult = vi.fn()
    const scheduler = createCapacityScheduler({
      capacity: {
        reserveDue: vi.fn().mockResolvedValue([{ connectionId: 'c1', bucket: 'cold' }]),
        attachJob: vi.fn(), markPaused, recordError: vi.fn(),
      },
      jobs: { enqueueWithResult },
      getConnectionConfig: vi.fn().mockResolvedValue({ scanEnabled: false }),
    })
    await scheduler.runOnce()
    expect(markPaused).toHaveBeenCalledWith('c1', 'cold')
    expect(enqueueWithResult).not.toHaveBeenCalled()
  })
})
