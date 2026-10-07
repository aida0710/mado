import { fetchApi, errorFromResponse } from './api/http'
import { mediaMessages } from './mediaMessages'

// 大きな索引も少しずつ準備する。取得済みの位置をサーバーが次の要求で再利用する。
export const MAX_TAR_PREPARATION_MS = 5 * 60 * 1000
const MAX_RETRY_DELAY_MS = 5000
const DEFAULT_RETRY_DELAY_MS = 1000

export async function waitForTarPreparationRetry({ signal, seconds }: { signal?: AbortSignal; seconds?: number } = {}): Promise<void> {
  signal?.throwIfAborted()
  const delay = seconds != null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_DELAY_MS
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, Math.min(MAX_RETRY_DELAY_MS, delay))
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function prepareTarEntry(url: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + MAX_TAR_PREPARATION_MS
  for (;;) {
    signal.throwIfAborted()
    const response = await fetchApi(url, { method: 'HEAD', signal })
    if (response.status !== 202 || response.headers.get('X-Tar-Index-Pending') !== '1') {
      if (!response.ok) throw await errorFromResponse(response)
      return
    }
    if (Date.now() >= deadline) throw new Error(mediaMessages.tarPreparationTimeout)
    const seconds = Number(response.headers.get('Retry-After'))
    await waitForTarPreparationRetry({ signal, seconds })
  }
}
