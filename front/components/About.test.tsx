import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { About } from './About'

// テスト環境では vite の define が無いため buildInfo はフォールバック値
// (version=0.0.0 / commit='dev')。ここでは描画構造とリンクを検証する。
describe('About', () => {
  it('設定標準の見出しでversionとrepositoryを表示する', () => {
    render(<About />)
    expect(screen.getByRole('heading', { name: 'アプリケーション情報' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'About' })).not.toBeInTheDocument()
    expect(screen.queryByText(/オブジェクトストレージを横断的に/)).not.toBeInTheDocument()
    expect(screen.getByText(/^v\d+\.\d+\.\d+$/)).toBeInTheDocument()
    const repo = screen.getByRole('link', { name: /github\.com\/aida0710\/mado/ })
    expect(repo).toHaveAttribute('href', 'https://github.com/aida0710/mado')
  })

  it('コミット情報が無ければリンクにせず文字だけ出す', () => {
    render(<About />)
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'dev' })).toBeNull()
  })
})
