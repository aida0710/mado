import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { EDITOR_NAME_KEY } from '../lib/editorName'
import { SignatureSettings } from './SignatureSettings'

beforeEach(() => localStorage.clear())

describe('SignatureSettings', () => {
  it('保存済みの署名名を初期表示する', () => {
    localStorage.setItem(EDITOR_NAME_KEY, 'tanaka')
    render(<SignatureSettings />)
    expect(screen.getByLabelText('署名名')).toHaveValue('tanaka')
  })

  it('入力欄から離れると保存する', () => {
    render(<SignatureSettings />)
    const input = screen.getByLabelText('署名名')
    fireEvent.change(input, { target: { value: 'sato' } })
    fireEvent.blur(input)

    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBe('sato')
    expect(screen.getByText('保存しました')).toBeInTheDocument()
  })

  it('Enter でも保存する', () => {
    render(<SignatureSettings />)
    const input = screen.getByLabelText('署名名')
    fireEvent.change(input, { target: { value: 'suzuki' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBe('suzuki')
  })

  // 空にしたらキーごと消す。空文字が残ると「設定済み」と区別がつかない。
  it('空にすると設定を消す', () => {
    localStorage.setItem(EDITOR_NAME_KEY, 'tanaka')
    render(<SignatureSettings />)
    const input = screen.getByLabelText('署名名')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)

    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBeNull()
  })

  it('前後の空白は落として保存する', () => {
    render(<SignatureSettings />)
    const input = screen.getByLabelText('署名名')
    fireEvent.change(input, { target: { value: '  aida  ' } })
    fireEvent.blur(input)

    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBe('aida')
  })
})
