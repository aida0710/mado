import { describe, expect, it } from 'vitest'
import { createSemaphore } from './semaphore.js'

describe('createSemaphore', () => {
  it('limit を超える実行は先行の release まで待つ (FIFO)', async () => {
    const sem = createSemaphore(2)
    const order: number[] = []
    const releases: Array<() => void> = []
    const task = async (n: number): Promise<void> => {
      const release = await sem.acquire()
      order.push(n)
      releases.push(release)
    }
    const p1 = task(1)
    const p2 = task(2)
    const p3 = task(3)
    await Promise.resolve()
    await p1
    await p2
    expect(order).toEqual([1, 2]) // 3 はまだ待っている
    releases[0]()
    await p3
    expect(order).toEqual([1, 2, 3])
  })

  it('release の二重呼び出しは冪等で、上限が保たれる', async () => {
    const sem = createSemaphore(1)
    const release = await sem.acquire()
    release()
    release() // 二重呼び出し — 無視されるべき

    const order: number[] = []
    const releases: Array<() => void> = []
    const task = async (n: number): Promise<void> => {
      const r = await sem.acquire()
      order.push(n)
      releases.push(r)
    }
    const p1 = task(1)
    const p2 = task(2)
    await Promise.resolve()
    await p1
    // 1 つ目だけが即時取得でき、2 つ目は待たされる（上限 1 が保たれている）
    expect(order).toEqual([1])
    releases[0]()
    await p2
    expect(order).toEqual([1, 2])
  })
})
