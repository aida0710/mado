import { describe, expect, it, vi } from 'vitest'
import { createRevalidationReceiver } from './revalidationReceiver'

describe('キャッシュと再取得の表示順', () => {
  it('先に届くキャッシュを表示してから再取得した値へ更新する', () => {
    const receive = vi.fn()
    const receiver = createRevalidationReceiver(receive)
    receiver.receiveInitial('cached')
    receiver.receiveRevalidated('fresh')
    expect(receive.mock.calls).toEqual([['cached'], ['fresh']])
  })

  it('再取得の完了後に初期キャッシュが届いても最新の表示を維持する', () => {
    const receive = vi.fn()
    const receiver = createRevalidationReceiver(receive)
    receiver.receiveRevalidated('fresh')
    receiver.receiveInitial('cached')
    expect(receive.mock.calls).toEqual([['fresh']])
  })
})
