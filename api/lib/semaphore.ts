import { RequestQueueFullError } from './shared-requests.js'

// FIFO セマフォ。待機中の中断で空いた枠を次の要求に渡す。
export interface Semaphore {
  acquire(signal?: AbortSignal): Promise<() => void>
}

// 動画・解析の待ち行列がメモリだけで増え続けないよう制限する。
const DEFAULT_MAX_WAITERS = 32

export function createSemaphore(limit: number, maxWaiters = DEFAULT_MAX_WAITERS): Semaphore {
  let active = 0
  const waiters: Array<() => void> = []
  // acquire ごとに新しい release クロージャを返し、二重呼び出しを冪等化する。
  // 同じ release を 2 回呼んでも active が実際の保有数より減らないようにする。
  function makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      active--
      const next = waiters.shift()
      if (next) next()
    }
  }
  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted()
      if (active < limit) {
        active++
        return Promise.resolve(makeRelease())
      }
      if (waiters.length >= maxWaiters) return Promise.reject(new RequestQueueFullError())
      return new Promise((resolve, reject) => {
        const start = (): void => {
          signal?.removeEventListener('abort', abort)
          active++
          resolve(makeRelease())
        }
        const abort = (): void => {
          const index = waiters.indexOf(start)
          if (index >= 0) waiters.splice(index, 1)
          reject(signal?.reason)
        }
        waiters.push(start)
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
  }
}
