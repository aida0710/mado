import { use, useEffect, useReducer } from 'react'
import { api } from './api/client'
import { ALL_CAPABILITIES_ON } from './api/types'
import type { Capabilities, Connection } from './api/types'
import { ConnectionContext } from './connectionContext'

// 接続ごとに許可された操作を返すフック。危険な導線 (ダウンロード / アーカイブ展開 /
// 音声解析 / README 書き戻し) をここで隠す。
//
// **これは表示上のゲートに過ぎない**。実際の遮断は API 側 (403) が担う
// — 共有 Web URL を直に開かれても止まるように。したがって「取得できるまでは
// 全許可」で描画してよい (押しても 403 になるだけ)。
//
// 取得経路は 2 つ:
//  - Storage 配下: StoragePage が既に接続を読んで ConnectionContext に入れている
//    ので、追加の fetch なしでそこから読む。
//  - BottomDock のピン留めカード: <Routes> の外に居て context が無く、しかも
//    今開いている接続とは別の接続のファイルを表示しうる。この場合だけ接続一覧を
//    取りに行く (セッション内でメモ化するので実際の fetch は 1 回)。

let connectionsPromise: Promise<Connection[]> | null = null

function loadConnections(): Promise<Connection[]> {
  // async IIFE: api 層が同期 throw しても reject に変換して、呼び出し側の
  // .catch で拾えるようにする。失敗はメモしない (次のマウントで再試行する)。
  connectionsPromise ??= (async () => api.listConnections())()
    .catch((e: unknown) => { connectionsPromise = null; throw e })
  return connectionsPromise
}

/** 接続の作成 / 更新 / 削除の後に呼ぶ。次回の参照で読み直す。 */
export function invalidateCapabilitiesCache(): void {
  connectionsPromise = null
}

export function useCapabilities(connId?: string): Capabilities {
  const ctx = use(ConnectionContext)
  const fromContext = ctx && (connId === undefined || ctx.id === connId)
    ? ctx.capabilities
    : null

  const [fetched, dispatch] = useReducer(
    (_: Capabilities | null, next: Capabilities | null) => next,
    null,
  )

  useEffect(() => {
    if (fromContext || connId === undefined) return
    let cancelled = false
    loadConnections()
      .then(list => {
        const found = list.find(c => c.id === connId)
        if (!cancelled && found) dispatch(found.capabilities)
      })
      // 失敗時は全許可のまま。API 側が 403 で止めるので実害はない。
      .catch(() => { /* noop */ })
    return () => { cancelled = true }
  }, [connId, fromContext])

  return fromContext ?? fetched ?? ALL_CAPABILITIES_ON
}
