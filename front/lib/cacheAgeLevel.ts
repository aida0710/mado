// CacheBanner の取得時刻を、取得からの経過時間で色分けするための段階。
//
// 一覧や README は取得から数時間経つと S3 の最新状態とずれていることがあるが、
// 「6時間前」の文字を読むまで気づけなかった。色で一目に分かるようにする。
// 色そのものは App.css の --color-cache-age-* が持つ。within-1h には色を付けない。

/** 段階ごとの経過時間の上限。1・3・6・12・24 時間で区切る (2026-09-29 利用者と決定)。 */
const CACHE_AGE_LEVELS = [
  { level: 'within-1h', maxHours: 1, label: '取得から1時間未満' },
  { level: 'within-3h', maxHours: 3, label: '取得から1〜3時間' },
  { level: 'within-6h', maxHours: 6, label: '取得から3〜6時間' },
  { level: 'within-12h', maxHours: 12, label: '取得から6〜12時間' },
  { level: 'within-24h', maxHours: 24, label: '取得から12〜24時間' },
] as const

const OVER_24H = { level: 'over-24h', label: '取得から24時間以上' } as const

export type CacheAgeLevel = (typeof CACHE_AGE_LEVELS)[number]['level'] | typeof OVER_24H.level

const MS_PER_HOUR = 3_600_000

/** 取得時刻が現在より後 (端末の時計のずれ) なら、いちばん新しい段階にする。 */
export function cacheAgeLevel(fetchedAt: Date, now: Date): { level: CacheAgeLevel; label: string } {
  const ageHours = (now.getTime() - fetchedAt.getTime()) / MS_PER_HOUR
  const found = CACHE_AGE_LEVELS.find(candidate => ageHours < candidate.maxHours)
  return found ?? OVER_24H
}
