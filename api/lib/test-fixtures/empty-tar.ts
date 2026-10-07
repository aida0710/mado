const BLOCK_SIZE = 512

function writeHeader(header: Buffer, { name, size, type }: { name: string; size: number; type: string }): void {
  header.write(name)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
}

export function createTarHeader(entry: { name: string; size: number; type: string }): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE)
  writeHeader(header, entry)
  return header
}

// 大量の空ファイルが並ぶtar。本文を使わず、索引の再開・ページ境界を確認する。
export function createEmptyTar(entryCount: number): Buffer {
  const archive = Buffer.alloc((entryCount + 2) * BLOCK_SIZE)
  for (let ordinal = 0; ordinal < entryCount; ordinal++) {
    writeHeader(archive.subarray(ordinal * BLOCK_SIZE, (ordinal + 1) * BLOCK_SIZE), {
      name: `file-${ordinal}.mp4`, size: 0, type: '0',
    })
  }
  return archive
}
