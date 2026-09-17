import type { z } from 'zod'
import { Tag, TagAssignmentMap, TagList, TagSearchResult } from './types'
import type { TagCreateInput, TagUpdateInput, TargetKind } from './types'
import { SHORT_CACHE_TTL_MS, TTLCache } from './cache'
import { API_BASE, cacheKey, getJson, mutateJson, storagePath } from './http'

const tagsCache = new TTLCache<z.infer<typeof TagList>>(SHORT_CACHE_TTL_MS)
const tagAssignmentsCache = new TTLCache<z.infer<typeof TagAssignmentMap>>(SHORT_CACHE_TTL_MS)

/** 「どの対象に、どのタグを」。assign / unassign で同じ形。 */
export interface TagAssignmentTarget {
  connectionId: string
  bucket: string
  kind: TargetKind
  path: string
  tagId: string
}

const assignmentsScope = (connectionId: string, bucket: string, kind: TargetKind) =>
  cacheKey('tagAssignments', connectionId, bucket, kind)

// タグの定義 (Settings) と、bucket / prefix / file への割り当て。
export const tagsClient = {
  tags: () => tagsCache.get('tags', () => getJson(`${API_BASE}/tags`, TagList)),

  invalidateTags: (): void => { tagsCache.invalidate('tags') },

  createTag: async (input: TagCreateInput): Promise<z.infer<typeof Tag>> => {
    const tag = await mutateJson(`${API_BASE}/tags`, { method: 'POST', body: input }, Tag)
    tagsCache.invalidate('tags')
    return tag
  },

  updateTag: async (id: string, input: TagUpdateInput): Promise<z.infer<typeof Tag>> => {
    const tag = await mutateJson(`${API_BASE}/tags/${encodeURIComponent(id)}`, { method: 'PUT', body: input }, Tag)
    tagsCache.invalidate('tags')
    return tag
  },

  deleteTag: async (id: string): Promise<void> => {
    await mutateJson(`${API_BASE}/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }, null)
    tagsCache.invalidate('tags')
  },

  // 一覧をまとめて hydrate するバッチ取得。paths が空なら fetch しない
  // (呼び出し側が dirs/files 0 件のときに空 URL を叩かないための短絡)。
  tagAssignments: ({ connectionId, bucket, kind, paths }: {
    connectionId: string; bucket: string; kind: TargetKind; paths: string[]
  }): Promise<z.infer<typeof TagAssignmentMap>> => {
    if (paths.length === 0) return Promise.resolve({})
    return tagAssignmentsCache.get(cacheKey('tagAssignments', connectionId, bucket, kind, ...paths), () => {
      const search = new URLSearchParams({ bucket, kind })
      for (const path of paths) search.append('paths', path)
      return getJson(`${storagePath(connectionId, '/tags')}?${search.toString()}`, TagAssignmentMap)
    })
  },

  invalidateTagAssignments: (connectionId: string, bucket: string, kind: TargetKind): void => {
    tagAssignmentsCache.invalidatePrefix(assignmentsScope(connectionId, bucket, kind))
  },

  assignTag: async ({ connectionId, bucket, kind, path, tagId }: TagAssignmentTarget): Promise<void> => {
    await mutateJson(storagePath(connectionId, '/tags'), { method: 'PUT', body: { bucket, kind, path, tagId } }, null)
    tagAssignmentsCache.invalidatePrefix(assignmentsScope(connectionId, bucket, kind))
  },

  unassignTag: async ({ connectionId, bucket, kind, path, tagId }: TagAssignmentTarget): Promise<void> => {
    await mutateJson(storagePath(connectionId, '/tags'), { method: 'DELETE', body: { bucket, kind, path, tagId } }, null)
    tagAssignmentsCache.invalidatePrefix(assignmentsScope(connectionId, bucket, kind))
  },

  // 同一接続内の全バケットを横断して、選んだタグのいずれかが付いた対象を返す。
  tagSearch: (connectionId: string, tagIds: string[]): Promise<z.infer<typeof TagSearchResult>> => {
    const search = new URLSearchParams()
    for (const id of tagIds) search.append('tagId', id)
    return getJson(`${storagePath(connectionId, '/tags/search')}?${search.toString()}`, TagSearchResult)
  },
}
