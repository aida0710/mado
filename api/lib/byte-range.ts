export interface ByteRange {
  start: number
  end: number
}

/** ファイル内の単一区間に変換する。不正・範囲外・複数区間はnull。 */
export function parseByteRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || size === 0) return null
  const [, first, last] = match
  if (!first && !last) return null

  if (!first) {
    const suffixSize = Number(last)
    if (!Number.isSafeInteger(suffixSize) || suffixSize <= 0) return null
    return { start: Math.max(0, size - suffixSize), end: size - 1 }
  }

  const start = Number(first)
  const end = last ? Number(last) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}
