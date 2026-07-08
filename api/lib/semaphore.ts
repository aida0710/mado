// FIFO セマフォ。media-worker の同期解析スロット制御に使う。
// 上限超過のリクエストは 503 にせず順番待ちさせる (LAN 内前提)。
export interface Semaphore {
  acquire(): Promise<() => void>
}

export function createSemaphore(limit: number): Semaphore {
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
    acquire(): Promise<() => void> {
      if (active < limit) {
        active++
        return Promise.resolve(makeRelease())
      }
      return new Promise(resolve => {
        waiters.push(() => {
          active++
          resolve(makeRelease())
        })
      })
    },
  }
}
