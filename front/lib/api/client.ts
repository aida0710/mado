import { capacityClient } from './capacity-client'
import { connectionsClient } from './connections-client'
import { favoritesClient } from './favorites-client'
import { jobsClient } from './jobs-client'
import { lineageClient } from './lineage-client'
import { mediaClient } from './media-client'
import { notesClient } from './notes-client'
import { previewClient } from './preview-client'
import { pricingClient } from './pricing-client'
import { readmeClient } from './readme-client'
import { settingsClient } from './settings-client'
import { storageListClient } from './storage-list-client'
import { tagsClient } from './tags-client'

export type { Revalidatable } from './http'
export type { ListCursor } from './storage-list-client'
export type { TarEntry, TarPreviewCallbacks } from './preview-client'

// 内部 API のクライアント。実体は領域ごとの *-client.ts にあり、ここは 1 つの
// `api` に束ねるだけ。画面側は領域を意識せず api.xxx で呼ぶ。
// キャッシュの方針は cache.ts、HTTP の共通処理は http.ts。
export const api = {
  ...notesClient,
  ...connectionsClient,
  ...storageListClient,
  ...readmeClient,
  ...previewClient,
  ...mediaClient,
  ...favoritesClient,
  ...tagsClient,
  ...settingsClient,
  ...lineageClient,
  ...jobsClient,
  ...capacityClient,
  ...pricingClient,

  // 該当キャッシュエントリが「いつ S3 から取得されたか」を Date で返す。
  // null = まだ取得していない / 取得失敗 / invalidate された直後。
  // UI で「取得 HH:mm」を薄く表示してキャッシュ鮮度をユーザに見せるのに使う。
  lastFetched: {
    ...storageListClient.lastFetched,
    ...readmeClient.lastFetched,
    ...previewClient.lastFetched,
  },
}
