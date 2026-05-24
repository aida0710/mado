import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { About } from './About'

// テスト環境では vite の define が無いため buildInfo はフォールバック値
// (version=0.0.0 / commit='dev')。ここでは描画構造とリンクを検証する。
describe('About', () => {
  it('renders the description, version and repository link', () => {
    render(<About />)
    expect(screen.getByText(/オブジェクトストレージを横断的に/)).toBeInTheDocument()
    expect(screen.getByText(/^v\d+\.\d+\.\d+$/)).toBeInTheDocument()
    const repo = screen.getByRole('link', { name: /github\.com\/aida0710\/web-dashboard/ })
    expect(repo).toHaveAttribute('href', 'https://github.com/aida0710/web-dashboard')
  })

  it('shows the commit as plain text (no link) when commit info is absent', () => {
    render(<About />)
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'dev' })).toBeNull()
  })
})
