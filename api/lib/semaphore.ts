// FIFO セマフォ。media-worker の同期解析スロット制御に使う。
// 上限超過のリクエストは 503 にせず順番待ちさせる (LAN 内前提)。
export interface Semaphore {
  acquire(): Promise<() => void>
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0
  const waiters: Array<() => void> = []
  const release = (): void => {
    active--
    const next = waiters.shift()
    if (next) next()
  }
  return {
    acquire(): Promise<() => void> {
      if (active < limit) {
        active++
        return Promise.resolve(release)
      }
      return new Promise(resolve => {
        waiters.push(() => {
          active++
          resolve(release)
        })
      })
    },
  }
}
