import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../lib/auth-context'
import { EDITOR_NAME_KEY } from '../lib/editorName'
import { SignatureSettings } from './SignatureSettings'

beforeEach(() => localStorage.clear())

describe('SignatureSettings', () => {
  it('保存済みの署名名を初期表示する', () => {
    localStorage.setItem(EDITOR_NAME_KEY, 'tanaka')
    render(<SignatureSettings />)
    expect(screen.getByLabelText('署名名')).toHaveValue('tanaka')
  })

  it('保存ボタンで端末署名を保存する（認証無効時の互換動作）', async () => {
    const user = userEvent.setup()
    render(<SignatureSettings />)
    const input = screen.getByLabelText('署名名')
    fireEvent.change(input, { target: { value: 'sato' } })
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBe('sato')
    expect(screen.getByText('保存しました')).toBeInTheDocument()
  })

  it('Enterでも保存する', async () => {
    const user = userEvent.setup()
    render(<SignatureSettings />)
    const input = screen.getByLabelText('署名名')
    fireEvent.change(input, { target: { value: 'suzuki' } })
    await user.type(input, '{Enter}')

    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBe('suzuki')
  })

  it('前後の空白は落として保存する', async () => {
    const user = userEvent.setup()
    render(<SignatureSettings />)
    const input = screen.getByLabelText('署名名')
    fireEvent.change(input, { target: { value: '  aida  ' } })
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBe('aida')
  })

  it('認証時はアカウント署名をAPIへ保存して再読込する', async () => {
    const reload = vi.fn().mockResolvedValue(undefined)
    const auth: AuthContextValue = {
      enabled: true,
      user: {
        id: 'user-1', username: 'aida', email: null, displayName: '相田',
        signatureName: '旧署名', roles: ['admin'], permissions: [], mustChangePassword: false, authMethods: ['local'],
      },
      logout: async () => {},
      reload,
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const user = userEvent.setup()
    render(<AuthContext.Provider value={auth}><SignatureSettings /></AuthContext.Provider>)

    const input = screen.getByLabelText('署名名')
    await user.clear(input)
    await user.type(input, '新しい署名')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/profile', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ displayName: '相田', username: 'aida', signatureName: '新しい署名' }),
    }))
    expect(reload).toHaveBeenCalledOnce()
    expect(localStorage.getItem(EDITOR_NAME_KEY)).toBeNull()
  })

  it('従来の設定見出しに揃え、末尾からサインアウトできる', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    const auth: AuthContextValue = {
      enabled: true,
      user: {
        id: 'user-1', username: 'aida', email: null, displayName: '相田',
        signatureName: '相田', roles: ['admin'], permissions: [], mustChangePassword: false, authMethods: ['local'],
      },
      logout,
      reload: async () => {},
    }
    const user = userEvent.setup()
    render(<AuthContext.Provider value={auth}><SignatureSettings /></AuthContext.Provider>)

    expect(screen.getByRole('heading', { name: 'アカウントと署名の管理' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Account' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'サインアウト' }))
    expect(logout).toHaveBeenCalledOnce()
  })
})
