import { readFileSync } from 'node:fs'
import type { RangeReader } from '../tar-range.js'

// 実際のtarヘッダーだけを使い、GB単位の本文は要求された範囲だけ生成する。
const GIB_BYTES = 1024 ** 3
const HEADER_BYTES = 512

export interface VirtualTar {
  size: number
  videoSize: number
  videoOffset: number
  read: RangeReader
}

export function createVirtualTar(gigabytes: 1 | 10 = 1): VirtualTar {
  const header = readFileSync(new URL(`./video-${gigabytes}gib.header`, import.meta.url))
  const followingEntries = readFileSync(new URL('./sample.tar', import.meta.url))
  const videoSize = gigabytes * GIB_BYTES
  const followingOffset = HEADER_BYTES + videoSize
  const ending = Buffer.from('VIDEO-END')
  const regions = [
    { offset: 0, bytes: header },
    { offset: followingOffset - ending.length, bytes: ending },
    { offset: followingOffset, bytes: followingEntries },
  ]
  const size = followingOffset + followingEntries.length
  const read: RangeReader = async (start, length) => {
    const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - start)))
    for (const region of regions) {
      const copyStart = Math.max(start, region.offset)
      const copyEnd = Math.min(start + bytes.length, region.offset + region.bytes.length)
      if (copyEnd > copyStart) region.bytes.copy(bytes, copyStart - start, copyStart - region.offset, copyEnd - region.offset)
    }
    return bytes
  }
  return { size, videoSize, videoOffset: HEADER_BYTES, read }
}
