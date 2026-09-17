import { z } from 'zod'
import { Connection, ConnectionAccessUsers, ConnectionList } from './types'
import type { ConnectionCreateInput, ConnectionUpdateInput } from './types'
import { API_BASE, getJson, mutateJson } from './http'

const connectionPath = (id: string) => `${API_BASE}/connections/${encodeURIComponent(id)}`

// 接続 (S3 互換ストレージ) の登録。一覧はキャッシュ層を通さないので、
// 変更後は再取得するだけで最新が見える。
export const connectionsClient = {
  listConnections: () => getJson(`${API_BASE}/connections`, ConnectionList),

  listConnectionAccessUsers: () =>
    getJson(`${API_BASE}/connections/access-users`, ConnectionAccessUsers),

  createConnection: (input: ConnectionCreateInput) =>
    mutateJson(`${API_BASE}/connections`, { method: 'POST', body: input }, Connection),

  updateConnection: (id: string, input: ConnectionUpdateInput) =>
    mutateJson(connectionPath(id), { method: 'PUT', body: input }, Connection),

  deleteConnection: (id: string) =>
    mutateJson(connectionPath(id), { method: 'DELETE' }, null),

  setDefaultConnection: async (id: string): Promise<void> => {
    await mutateJson(`${connectionPath(id)}/default`, { method: 'PUT' }, z.object({ ok: z.boolean() }))
  },
}
