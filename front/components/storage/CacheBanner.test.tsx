import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CacheBanner } from './CacheBanner'

const AT = new Date('2026-08-17T22:13:00+09:00')

describe('CacheBanner', () => {
  it('fetchedAt が無ければ何も描画しない (初回ロード前 / invalidate 直後)', () => {
    const { container } = render(<CacheBanner fetchedAt={null} revalidating={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('最新のときは取得時刻だけを 1 行で出し、progress は出さない', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={false} />)
    expect(screen.getByText(/取得した最新の情報です/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/更新しています/)).toBeNull()
  })

  it('更新中は「いつ取得したか」と更新中である旨、progress を出す', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={true} />)
    expect(screen.getByText(/に取得されたものです/)).toBeInTheDocument()
    expect(screen.getByText(/最新の情報に更新しています/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('取得時刻を人間が読める形とマシンが読める形の両方で持つ', () => {
    render(<CacheBanner fetchedAt={AT} revalidating={true} />)
    // 画面には短い表記、title/dateTime には曖昧さの無い ISO を入れる
    const time = screen.getByText(/08\/17 22:13|22:13/)
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('dateTime', AT.toISOString())
  })

  it('更新中は aria-live で読み上げに乗せる', () => {
    const { container } = render(<CacheBanner fetchedAt={AT} revalidating={true} />)
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  })
})
