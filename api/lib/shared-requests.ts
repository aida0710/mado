// 同じ取得を共有し、最後の利用者が離れたときだけ上流を中断する。
export class RequestQueueFullError extends Error {
  constructor() { super('request queue is full'); this.name = 'RequestQueueFullError' }
}

interface PendingRequest<T> {
  controller: AbortController
  promise: Promise<T>
  subscribers: Set<symbol>
}

// 上流を止めずに無制限の異なる取得を溜めない。
const MAX_PENDING_REQUESTS = 64

export class SharedRequests<T> {
  private readonly pending = new Map<string, PendingRequest<T>>()

  run({ key, signal, load }: { key: string; signal?: AbortSignal; load: (signal: AbortSignal) => Promise<T> }): Promise<T> {
    signal?.throwIfAborted()
    let request = this.pending.get(key)
    if (!request) {
      if (this.pending.size >= MAX_PENDING_REQUESTS) throw new RequestQueueFullError()
      const controller = new AbortController()
      const created: PendingRequest<T> = {
        controller, subscribers: new Set(),
        promise: Promise.resolve().then(() => load(controller.signal)).finally(() => {
          if (this.pending.get(key) === created) this.pending.delete(key)
        }),
      }
      this.pending.set(key, created)
      request = created
    }
    const shared = request
    const subscriber = Symbol()
    shared.subscribers.add(subscriber)
    return new Promise<T>((resolve, reject) => {
      const leave = (): void => {
        signal?.removeEventListener('abort', abort)
        shared.subscribers.delete(subscriber)
      }
      const abort = (): void => {
        leave()
        if (shared.subscribers.size === 0) {
          if (this.pending.get(key) === shared) this.pending.delete(key)
          shared.controller.abort(signal?.reason)
        }
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      shared.promise.then(value => { leave(); resolve(value) }, error => { leave(); reject(error) })
    })
  }
}
