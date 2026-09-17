import { useEffect, useReducer } from 'react'
import type { HistoryListItem } from './api/types'

export interface HistoryVersionBody {
  id: number
  body: string
}

/** 履歴の取得元。README と Team note で API が違うので、呼び出し側が関数で渡す。
 *  どちらも useCallback で安定させること。変わると一覧を読み直す。 */
export interface HistorySource {
  loadVersions: () => Promise<HistoryListItem[]>
  loadVersion: (id: number) => Promise<HistoryVersionBody>
}

export interface HistoryVersionsState {
  versions: HistoryListItem[] | null
  error: string | null
  selectedId: number | null
  selectedBody: HistoryVersionBody | null
}

type Action =
  | { type: 'versionsLoaded'; versions: HistoryListItem[] }
  | { type: 'selectVersion'; id: number }
  | { type: 'bodyLoaded'; body: HistoryVersionBody }
  | { type: 'fail'; error: string }

const initial: HistoryVersionsState = {
  versions: null, error: null, selectedId: null, selectedBody: null,
}

function reducer(state: HistoryVersionsState, action: Action): HistoryVersionsState {
  switch (action.type) {
    case 'versionsLoaded':
      return {
        ...state,
        versions: action.versions,
        selectedId: action.versions.length > 0 ? action.versions[0].id : null,
      }
    case 'selectVersion':
      return { ...state, selectedId: action.id, selectedBody: null }
    case 'bodyLoaded':
      // 版 A を選んだ直後に B を選ぶと A の応答が後から届くことがある。
      // 今選んでいる版の本文だけを受け取り、遅れて届いた別の版は捨てる。
      if (action.body.id !== state.selectedId) return state
      return { ...state, selectedBody: action.body }
    case 'fail':
      return { ...state, error: action.error }
  }
}

/** 編集履歴の一覧と、選択中の版の本文を読む。
 *  一覧が届いたら最新の版を選び、版を切り替えるたびに本文を取りに行く。 */
export function useHistoryVersions(source: HistorySource): {
  state: HistoryVersionsState
  selectVersion: (id: number) => void
} {
  const [state, dispatch] = useReducer(reducer, initial)
  const { loadVersions, loadVersion } = source

  useEffect(() => {
    loadVersions()
      .then(versions => dispatch({ type: 'versionsLoaded', versions }))
      .catch((e: Error) => dispatch({ type: 'fail', error: e.message }))
  }, [loadVersions])

  const { selectedId } = state
  useEffect(() => {
    if (selectedId == null) return
    loadVersion(selectedId)
      .then(body => dispatch({ type: 'bodyLoaded', body: { id: body.id, body: body.body } }))
      .catch((e: Error) => dispatch({ type: 'fail', error: e.message }))
  }, [loadVersion, selectedId])

  return {
    state,
    selectVersion: id => dispatch({ type: 'selectVersion', id }),
  }
}
