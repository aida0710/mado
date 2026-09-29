import { describe, expect, it } from 'vitest'
import type { AuthUser } from './auth-context'
import { nextAuthSession, SIGNED_OUT, type AuthSessionState } from './auth-session-state'

const aida: AuthUser = {
  id: 'user-1', username: 'aida', email: null, displayName: '相田',
  signatureName: '相田', roles: ['admin'], permissions: [], mustChangePassword: false, authMethods: ['local'],
}
const sato: AuthUser = { ...aida, id: 'user-2', username: 'sato', displayName: '佐藤', signatureName: '佐藤' }

const signedInAs = (user: AuthUser): AuthSessionState => ({ user, screenUser: user, sessionExpired: false })
const expiredOn = (user: AuthUser): AuthSessionState => ({ user: null, screenUser: user, sessionExpired: true })

describe('nextAuthSession', () => {
  it('起動時に session が無ければ、残す画面も「切れた」の理由も持たない', () => {
    expect(nextAuthSession(SIGNED_OUT, { type: 'checked', user: null })).toEqual(SIGNED_OUT)
  })

  it('ログインすると、その User の画面を描く', () => {
    expect(nextAuthSession(SIGNED_OUT, { type: 'checked', user: aida })).toEqual(signedInAs(aida))
  })

  it('ログイン中に session が無くなると、画面を残したまま「切れた」とする', () => {
    expect(nextAuthSession(signedInAs(aida), { type: 'checked', user: null })).toEqual(expiredOn(aida))
  })

  it('session が切れたあと同じ User で入り直すと、残した画面を続けて使う', () => {
    const refreshed = { ...aida, displayName: '相田 正樹' }
    expect(nextAuthSession(expiredOn(aida), { type: 'checked', user: refreshed })).toEqual(signedInAs(refreshed))
  })

  it('session が切れたあと別の User で入り直すと、前の User の画面を捨ててその User の画面にする', () => {
    expect(nextAuthSession(expiredOn(aida), { type: 'checked', user: sato })).toEqual(signedInAs(sato))
  })

  it('同じ User がパスワードの変更を求められたら、変更後に戻れるよう画面を残す', () => {
    const mustChange = { ...aida, mustChangePassword: true }
    expect(nextAuthSession(expiredOn(aida), { type: 'checked', user: mustChange }))
      .toEqual({ user: mustChange, screenUser: aida, sessionExpired: false })
  })

  it('別の User がパスワードの変更を求められたら、前の User の画面を残さない', () => {
    const mustChange = { ...sato, mustChangePassword: true }
    expect(nextAuthSession(expiredOn(aida), { type: 'checked', user: mustChange }))
      .toEqual({ user: mustChange, screenUser: null, sessionExpired: false })
  })

  it('初回のパスワード変更の途中で session が切れると、残す画面は無いまま「切れた」とする', () => {
    const mustChange = { ...aida, mustChangePassword: true }
    const changingPassword = { user: mustChange, screenUser: null, sessionExpired: false }
    expect(nextAuthSession(changingPassword, { type: 'checked', user: null }))
      .toEqual({ user: null, screenUser: null, sessionExpired: true })
  })

  it('サインアウトすると、画面を残さない', () => {
    expect(nextAuthSession(signedInAs(aida), { type: 'loggedOut' })).toEqual(SIGNED_OUT)
    expect(nextAuthSession(expiredOn(aida), { type: 'loggedOut' })).toEqual(SIGNED_OUT)
  })
})
