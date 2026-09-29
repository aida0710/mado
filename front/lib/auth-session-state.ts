import type { AuthUser } from './auth-context'

/**
 * AuthGate が持つログインの状態。
 * session が切れても、同じ User で入り直せば書きかけの本文などを続きから使えるよう、
 * 今の session の User（user）とは別に、画面を描いている User（screenUser）を持つ。
 */
export interface AuthSessionState {
  /** 今の session の User。session が無ければ null。 */
  user: AuthUser | null
  /** 画面（AuthGate の children）を描いている User。null なら残す画面は無い。 */
  screenUser: AuthUser | null
  /** ログイン中に session が切れたか。ログイン画面で理由を伝える。 */
  sessionExpired: boolean
}

export type AuthSessionEvent =
  /** /api/auth/me で今の session の User を確かめた。null は session が無いこと。 */
  | { type: 'checked'; user: AuthUser | null }
  | { type: 'loggedOut' }

export const SIGNED_OUT: AuthSessionState = { user: null, screenUser: null, sessionExpired: false }

export function nextAuthSession(state: AuthSessionState, event: AuthSessionEvent): AuthSessionState {
  if (event.type === 'loggedOut') return SIGNED_OUT
  const { user } = event
  if (!user) {
    // ログイン中（state.user がある）に session が無くなったら、切れたと伝える。
    // 画面は、入り直すまで残す。
    return {
      user: null,
      screenUser: state.screenUser,
      sessionExpired: state.sessionExpired || state.user !== null,
    }
  }
  return { user, screenUser: screenUserAfterCheck(state.screenUser, user), sessionExpired: false }
}

// 入り直した User で、どの画面を描くかを決める。別の User の画面は、その User に見せない。
function screenUserAfterCheck(screenUser: AuthUser | null, user: AuthUser): AuthUser | null {
  if (!user.mustChangePassword) return user
  // パスワードを変えるまでは画面を使わせない。同じ User の画面は、変えたあとに戻れるよう残す。
  return screenUser?.id === user.id ? screenUser : null
}
