// ディレクトリ走査の集計 (spec: 2026-08-18-directory-scan-design.md)。
// S3 を知らない純ロジック。ページングは scan-handler.ts が持つ。

export interface ScanEntry {
  key: string
  size: number
}

export interface ScanResult {
  objectCount: number
  totalBytes: number
  /** 直下のサブディレクトリ別の内訳。サイズ降順、最大 50 件。 */
  children: Array<{ name: string; objectCount: number; totalBytes: number }>
  /** 拡張子別の内訳。サイズ降順、最大 10 件。 */
  extensions: Array<{ ext: string; objectCount: number; totalBytes: number }>
  /** 途中で S3 エラーが出たが、そこまでの集計を返しているか。 */
  partial: boolean
}

const CHILDREN_LIMIT = 50
const EXTENSIONS_LIMIT = 10

// 最後のドット以降を取ると .tar.gz が .gz になってしまうので、
// よく使う二重拡張子だけ先に判定する。
const DOUBLE_EXTS = ['.tar.gz', '.tar.xz', '.tar.bz2', '.tar.zst']

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  for (const d of DOUBLE_EXTS) {
    if (lower.endsWith(d)) return d
  }
  const dot = lower.lastIndexOf('.')
  const slash = lower.lastIndexOf('/')
  if (dot <= slash + 1) return '(なし)'
  return lower.slice(dot)
}

interface Bucket {
  objectCount: number
  totalBytes: number
}

function bump(m: Map<string, Bucket>, key: string, size: number): void {
  const cur = m.get(key)
  if (cur) {
    cur.objectCount += 1
    cur.totalBytes += size
  } else {
    m.set(key, { objectCount: 1, totalBytes: size })
  }
}

function topBySize(m: Map<string, Bucket>, limit: number): Array<[string, Bucket]> {
  return [...m.entries()]
    .sort((a, b) => b[1].totalBytes - a[1].totalBytes)
    .slice(0, limit)
}

export function createScanAccumulator(prefix: string) {
  let objectCount = 0
  let totalBytes = 0
  const children = new Map<string, Bucket>()
  const extensions = new Map<string, Bucket>()

  return {
    add(e: ScanEntry): void {
      // S3 互換実装が返す「そのディレクトリ自身」の 0 バイト placeholder は数えない。
      if (e.key === prefix) return

      objectCount += 1
      totalBytes += e.size

      const rest = e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key
      const slash = rest.indexOf('/')
      if (slash >= 0) bump(children, rest.slice(0, slash + 1), e.size)

      bump(extensions, extensionOf(rest), e.size)
    },

    count(): number {
      return objectCount
    },

    result(partial: boolean): ScanResult {
      return {
        objectCount,
        totalBytes,
        children: topBySize(children, CHILDREN_LIMIT).map(([name, v]) => ({
          name, objectCount: v.objectCount, totalBytes: v.totalBytes,
        })),
        extensions: topBySize(extensions, EXTENSIONS_LIMIT).map(([ext, v]) => ({
          ext, objectCount: v.objectCount, totalBytes: v.totalBytes,
        })),
        partial,
      }
    },
  }
}
