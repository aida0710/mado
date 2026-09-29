import type { Hono } from 'hono'
import type { Capability } from '../storage.js'
import { requireCapability, type GetConnectionConfig } from './capabilityGuard.js'

interface StorageCapabilityRoute {
  /** 省略したら全メソッド。同じパスでメソッドごとに権限が違うときだけ書く。 */
  method?: 'GET' | 'PUT'
  path: string
  capability: Capability
}

/**
 * Storage API のパスと、そのパスに必要な「接続ごとの権限」の対応表。
 * 「どのエンドポイントがどの権限に属するか」をここ 1 箇所に集約し、
 * ルートハンドラ側には権限の知識を持たせない。
 * 見積もり (/storage/:connectionId/estimate) は S3 を叩かないので載せない。
 */
export const STORAGE_CAPABILITY_ROUTES: readonly StorageCapabilityRoute[] = [
  { path: '/storage/:connectionId/buckets',              capability: 'list' },
  { path: '/storage/:connectionId/list',                 capability: 'list' },
  { path: '/storage/:connectionId/capacity',             capability: 'list' },
  { path: '/storage/:connectionId/capacity/*',           capability: 'list' },
  // 走査の結果にはサブディレクトリ名が入るので、一覧と同じ権限を要る。
  { path: '/storage/:connectionId/scan',                 capability: 'list' },
  { path: '/storage/:connectionId/preview/text',         capability: 'preview' },
  { path: '/storage/:connectionId/preview/image',        capability: 'preview' },
  { path: '/storage/:connectionId/preview/audio',        capability: 'preview' },
  { path: '/storage/:connectionId/preview/video',        capability: 'preview' },
  { path: '/storage/:connectionId/preview/raw',          capability: 'download' },
  { path: '/storage/:connectionId/preview/tar',          capability: 'archive' },
  { path: '/storage/:connectionId/preview/tar-entry',    capability: 'archive' },
  { path: '/storage/:connectionId/media/analyze',        capability: 'audioInfo' },
  { path: '/storage/:connectionId/media/spectrogram',    capability: 'audioSpectrogram' },
  // README は同じパスで GET = 読み込み / PUT = 編集。メソッドごとに権限が違う。
  { method: 'GET', path: '/storage/:connectionId/readme', capability: 'readmeRead' },
  { method: 'PUT', path: '/storage/:connectionId/readme', capability: 'readmeWrite' },
  { path: '/storage/:connectionId/readme/history',       capability: 'readmeRead' },
  { path: '/storage/:connectionId/readme/history/:id',   capability: 'readmeRead' },
  { path: '/storage/:connectionId/readmes/search',       capability: 'readmeRead' },
]

/** 対応表のとおりに権限ガードを付ける。Hono は登録順に実行するので、ルートの mount より前に呼ぶこと。 */
export function mountStorageCapabilityGuards(app: Hono, getConnectionConfig: GetConnectionConfig): void {
  for (const route of STORAGE_CAPABILITY_ROUTES) {
    const guard = requireCapability(route.capability, getConnectionConfig)
    if (route.method) app.on(route.method, route.path, guard)
    else app.use(route.path, guard)
  }
}
