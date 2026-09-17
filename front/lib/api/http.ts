import type { z } from 'zod'

export const API_BASE = '/api/internal'

// 長 TTL のキャッシュを引く API が共通で受け取るオプション。
// onRevalidate を渡すと stale-while-revalidate になり、期限切れのキャッシュを
// 即返しつつ裏で再取得する。呼び出し側はこのコールバックに渡された Promise を
// await して新しい値で描き直し、その間 UI に「更新中」を出す (CacheBanner)。
// 渡さなければ従来通り、期限切れなら取得完了まで待つ。
export interface Revalidatable<T> {
  onRevalidate?: (fresh: Promise<T>) => void
}

// キャッシュキー作成。'|' は S3 のキー / prefix では出現しないため衝突しない。
export const cacheKey = (...parts: Array<string | number | null | undefined>): string =>
  parts.map(p => p ?? '').join('|')

/** サーバーが `{ error }` を返していればその文言、無ければ statusText を Error にする。 */
export async function errorFromResponse(res: Response): Promise<Error> {
  let message = res.statusText
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    /* JSON でないエラーボディ — statusText をそのまま使う */
  }
  return new Error(message)
}

/** fetch して、非 2xx ならサーバーのエラー文言で throw する。 */
export async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (!res.ok) throw await errorFromResponse(res)
  return res
}

export async function getJson<T extends z.ZodTypeAny>(
  url: string,
  schema: T,
): Promise<z.infer<T>> {
  const res = await fetchOk(url, { headers: { Accept: 'application/json' } })
  const json: unknown = await res.json()
  return schema.parse(json)
}

export function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value)
  }
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

export async function mutateJson<T extends z.ZodTypeAny>(
  url: string,
  init: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
  schema: T | null,
): Promise<T extends z.ZodTypeAny ? z.infer<T> : void> {
  const res = await fetchOk(url, {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (schema === null) return undefined as never
  const json: unknown = await res.json()
  return schema.parse(json) as never
}

/** `/storage/:connectionId` 配下の API パス。 */
export function storagePath(connectionId: string, suffix: string): string {
  return `${API_BASE}/storage/${encodeURIComponent(connectionId)}${suffix}`
}
