import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { SESSION_EXPIRED_MESSAGE, fetchOk } from './http'
import { subscribeUnauthorized } from './unauthorized-events'

function respondWith(status: number, body: unknown = { error: 'unauthorized' }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })))
}

const unsubscribers: Array<() => void> = []
function listenUnauthorized() {
  const listener = vi.fn()
  unsubscribers.push(subscribeUnauthorized(listener))
  return listener
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  vi.unstubAllGlobals()
})

describe('API の 401 の通知', () => {
  it('API が 401 を返すと、購読しているところへ知らせてからエラーにする', async () => {
    respondWith(401)
    const listener = listenUnauthorized()

    await expect(fetchOk('/api/internal/notes/home')).rejects.toThrow(SESSION_EXPIRED_MESSAGE)

    expect(listener).toHaveBeenCalledOnce()
  })

  it('401 以外の失敗では知らせない', async () => {
    const listener = listenUnauthorized()

    respondWith(403, { error: 'forbidden' })
    await expect(fetchOk('/api/internal/notes/home')).rejects.toThrow('forbidden')
    respondWith(500, { error: 'boom' })
    await expect(fetchOk('/api/internal/notes/home')).rejects.toThrow('boom')

    expect(listener).not.toHaveBeenCalled()
  })

  it('購読をやめたあとは知らせない', async () => {
    respondWith(401)
    const listener = vi.fn()
    const unsubscribe = subscribeUnauthorized(listener)
    unsubscribe()

    await expect(fetchOk('/api/internal/notes/home')).rejects.toThrow()

    expect(listener).not.toHaveBeenCalled()
  })

  it('404 や 409 を自分で扱う取得（走査結果・移送見積もり）でも 401 を知らせる', async () => {
    respondWith(401)
    const listener = listenUnauthorized()

    await expect(api.latestScan('c', 'b', 'p/')).rejects.toThrow(SESSION_EXPIRED_MESSAGE)
    await expect(api.estimate('c', 'b', 'p/')).rejects.toThrow(SESSION_EXPIRED_MESSAGE)

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('401 の理由は、サーバーの英語の文言ではなく日本語で返す', async () => {
    respondWith(401)
    await expect(fetchOk('/api/internal/notes/home')).rejects.toThrow('セッションが切れました')
  })
})
