import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CacheBanner } from './CacheBanner'

const AT = new Date('2026-08-17T22:13:00+09:00')
const noop = (): void => {}

describe('CacheBanner', () => {
  it('最新のときは progress も更新中の文言も出さない', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={false} onRefresh={noop} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/更新しています/)).toBeNull()
  })

  it('更新中は更新中である旨と progress を出す', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={true} onRefresh={noop} />)
    expect(screen.getByText(/最新の情報に更新しています/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('取得時刻を人間が読める形とマシンが読める形の両方で持つ', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={false} onRefresh={noop} />)
    const time = screen.getByText(/^2026\/08\/17 22:13\(/)
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('dateTime', AT.toISOString())
  })

  it('更新中は aria-live で読み上げに乗せる', () => {
    const { container } = render(<CacheBanner fetchedAt={AT} revalidating={true} onRefresh={noop} />)
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  })
})

describe('更新ボタン', () => {
  it('↻ を押すと onRefresh が呼ばれる', async () => {
    const onRefresh = vi.fn()
    render(<CacheBanner fetchedAt={AT} revalidating={false} onRefresh={onRefresh} />)
    await userEvent.click(screen.getByRole('button', { name: '再読み込み' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  // fetchedAt が無いのは初回ロード中や invalidate 直後。ここで更新手段が
  // 消えると、詰まったときにユーザーが何もできなくなる。
  it('fetchedAt が null でもボタンは出す (日時テキストだけ出さない)', () => {
    render(<CacheBanner fetchedAt={null} revalidating={false} onRefresh={noop} />)
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeInTheDocument()
    expect(screen.queryByText(/に取得した情報です/)).toBeNull()
  })

  it('絶対時刻と相対時刻を併記し、その後ろに説明文が続く', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={false} onRefresh={noop} />)
    // 時刻は <time>、説明文はその兄弟テキストなので要素をまたぐ。
    // 親要素の textContent でつながりを確認する。
    const time = screen.getByText(/^2026\/08\/17 22:13\(/)
    expect(time.parentElement?.textContent)
      .toMatch(/^2026\/08\/17 22:13\(.+\)に取得した情報です$/)
  })

  it('更新中はボタンを押せない', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={true} onRefresh={noop} />)
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeDisabled()
  })
})
