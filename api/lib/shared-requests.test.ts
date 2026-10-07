import { describe, expect, it, vi } from 'vitest'
import { RequestQueueFullError, SharedRequests } from './shared-requests.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('SharedRequests', () => {
  it('同じ取得は共有し、一人の中断ではほかの取得を止めない', async () => {
    const shared = new SharedRequests<string>()
    const upstream = deferred<string>()
    let upstreamSignal!: AbortSignal
    const load = vi.fn((signal: AbortSignal) => { upstreamSignal = signal; return upstream.promise })
    const controller = new AbortController()
    const first = shared.run({ key: 'a', signal: controller.signal, load })
    const second = shared.run({ key: 'a', load })
    await Promise.resolve()
    controller.abort(new Error('left'))
    await expect(first).rejects.toThrow('left')
    expect(upstreamSignal.aborted).toBe(false)
    upstream.resolve('content')
    await expect(second).resolves.toBe('content')
    expect(load).toHaveBeenCalledOnce()
  })

  it('全員が中断すると上流を止め、次の要求は新しく取得する', async () => {
    const shared = new SharedRequests<string>()
    const controller = new AbortController()
    const load = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const request = shared.run({ key: 'a', signal: controller.signal, load })
    await Promise.resolve()
    controller.abort(new Error('left'))
    await expect(request).rejects.toThrow('left')
    await expect(shared.run({ key: 'a', load: async () => 'new' })).resolves.toBe('new')
  })

  it('失敗した取得を残さず、異なるキーは混ぜない', async () => {
    const shared = new SharedRequests<string>()
    await expect(shared.run({ key: 'a', load: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
    const values = await Promise.all([
      shared.run({ key: 'a', load: async () => 'a' }),
      shared.run({ key: 'b', load: async () => 'b' }),
    ])
    expect(values).toEqual(['a', 'b'])
  })

  it('異なる待機要求が上限に達したら増やさず、既存の要求は共有できる', async () => {
    const shared = new SharedRequests<number>()
    const upstream = deferred<number>()
    const requests = Array.from({ length: 64 }, (_, i) => shared.run({ key: String(i), load: () => upstream.promise }))
    expect(() => shared.run({ key: 'overflow', load: async () => 1 })).toThrow(RequestQueueFullError)
    requests.push(shared.run({ key: '0', load: async () => 2 }))
    upstream.resolve(1)
    expect((await Promise.all(requests)).every(value => value === 1)).toBe(true)
  })
})
