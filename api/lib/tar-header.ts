import type { TarEntry } from './tar-stream.js'

// tarのヘッダーと本文のパディングは仕様で512バイト。
export const TAR_BLOCK_SIZE = 512

export function decodeTarHeader(header: Buffer): TarEntry | null {
  if (header.length !== TAR_BLOCK_SIZE) throw new Error('incomplete tar header')
  if (header.every(byte => byte === 0)) return null

  let checksum = 0
  let signedChecksum = 0
  for (let offset = 0; offset < header.length; offset++) {
    // checksum自身のフィールドは空白として数える。
    const byte = offset >= 148 && offset < 156 ? 0x20 : header[offset]
    checksum += byte
    signedChecksum += byte > 127 ? byte - 256 : byte
  }
  const expectedChecksum = decodeTarNumber(header.subarray(148, 156))
  if (expectedChecksum !== checksum && expectedChecksum !== signedChecksum) {
    throw new Error('invalid tar header checksum')
  }

  const name = decodeTarString(header.subarray(0, 100))
  // GNU形式では同じ位置に別のフィールドがあるため、ustarのprefixだけを読む。
  const prefix = header.subarray(257, 263).equals(Buffer.from('ustar\0'))
    ? decodeTarString(header.subarray(345, 500)) : ''
  const flag = String.fromCharCode(header[156] || 0x30)
  const type = flag === '0' || flag === '7' ? 'file'
    : flag === '5' ? 'directory'
    : flag === '2' ? 'symlink' : flag
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: decodeTarNumber(header.subarray(124, 136)),
    type,
  }
}

export function decodeTarString(field: Buffer): string {
  const nul = field.indexOf(0)
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8')
}

function decodeTarNumber(field: Buffer): number {
  let value: number
  if (field[0] & 0x80) {
    // GNUのbase-256は8GiB以上のファイルサイズにも使われる。
    if (field[0] & 0x40) throw new Error('negative tar size')
    let binaryValue = BigInt(field[0] & 0x7f)
    for (const byte of field.subarray(1)) binaryValue = (binaryValue << 8n) | BigInt(byte)
    value = Number(binaryValue)
  } else {
    const octal = decodeTarString(field).trim()
    if (octal && !/^[0-7]+$/.test(octal)) throw new Error('invalid tar number')
    value = octal ? parseInt(octal, 8) : 0
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('tar size exceeds safe integer range')
  return value
}

/** PAXの長さは文字数ではなくUTF-8のバイト数。日本語のパスもそのまま扱う。 */
export function decodePaxAttributes(body: Buffer): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null)
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space < 0) throw new Error('invalid PAX record')
    const rawLength = body.subarray(offset, space).toString('ascii')
    if (!/^\d+$/.test(rawLength)) throw new Error('invalid PAX record length')
    const length = Number(rawLength)
    const end = offset + length
    if (!Number.isSafeInteger(end) || end <= space + 1 || end > body.length || body[end - 1] !== 0x0a) {
      throw new Error('incomplete PAX record')
    }
    const record = body.subarray(space + 1, end - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals <= 0) throw new Error('invalid PAX attribute')
    attributes[record.slice(0, equals)] = record.slice(equals + 1)
    offset = end
  }
  return attributes
}
