import type { z } from 'zod'
import { notifyUnauthorized } from './unauthorized-events'

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

/** 401 のときに画面へ出す文言。サーバーの `unauthorized` は利用者に意味が伝わらないので置き換える。 */
export const SESSION_EXPIRED_MESSAGE = 'セッションが切れました。ログインし直してから、もう一度お試しください。'

/**
 * サーバーが `{ error }` を返していればその文言、無ければ statusText を Error にする。
 * 401 だけは、ログインし直せば直ることが分かるよう、決まった日本語にする。
 */
export async function errorFromResponse(res: Response): Promise<Error> {
  if (res.status === 401) return new Error(SESSION_EXPIRED_MESSAGE)
  let message = res.statusText
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    /* JSON でないエラーボディ — statusText をそのまま使う */
  }
  return new Error(message)
}

/**
 * API を fetch する。401（session が無い・切れた）なら AuthGate へ知らせ、画面を
 * ログイン画面へ戻せるようにする。session の後ろにある API を fetch するときは、ここを通す。
 *
 * 次の 4 つはここを通さない。ログインより前に呼ぶか、401 を AuthGate やログイン画面が
 * 自分で扱うため。
 * - /api/auth/config: ログインより前に呼ぶ。404 は認証が無効なことを表す
 * - /api/auth/me: AuthGate が session の有無を確かめる本体。401 は「ログインしていない」
 * - /api/auth/local/login: 401 はパスワードの誤り
 * - /api/auth/logout: AuthGate が 401 を「session はもう無い」として扱う
 */
export async function fetchApi(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.status === 401) notifyUnauthorized()
  return res
}

/** API を fetch して、非 2xx ならサーバーのエラー文言で throw する。 */
export async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetchApi(url, init)
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
