import { isMacOsMetadata, type TarEntry } from './tar-stream.js'
import { decodePaxAttributes, decodeTarHeader, decodeTarString, TAR_BLOCK_SIZE } from './tar-header.js'

export interface RangeOptions {
  entryLimit: number
  offset?: number
  signal?: AbortSignal
  onProgress?: (progress: { bytes: number; requests: number }) => void
}

export interface RangeListing {
  entries: TarEntry[]
  hasMore: boolean
}

export interface IndexedTarEntry extends TarEntry {
  bodyOffset: number
}

// 小さなJSONと隣接するヘッダーはまとめて読み、大きな本文は読み飛ばす。
const HEADER_CHUNK_BYTES = 256 * 1024
// 長名/PAXだけをバッファする。通常は数KBで、1MiB以上はメタデータとして受け付けない。
const MAX_METADATA_BYTES = 1024 * 1024

export type RangeReader = (start: number, length: number, signal?: AbortSignal) => Promise<Buffer>

/** ヘッダーの位置を順次記録し、一覧と本文取得で同じ索引を使う。 */
export class TarRangeIndex {
  private readonly entries: IndexedTarEntry[] = []
  private readonly entriesByName = new Map<string, IndexedTarEntry>()
  private position = 0
  private exhausted = false
  private chunk: { start: number; buffer: Buffer } | null = null
  private globalPax: Record<string, string> = {}
  private localPax: Record<string, string> = {}
  private longName: string | null = null
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly read: RangeReader) {}

  get entryCount(): number { return this.entries.length }

  async list(options: RangeOptions, onEntry?: (entry: TarEntry) => void): Promise<RangeListing> {
    return this.serialize(async () => {
      const offset = options.offset ?? 0
      const end = offset + options.entryLimit
      let emitted = offset
      const emitAvailable = (): void => {
        while (emitted < Math.min(end, this.entries.length)) {
          const { name, size, type } = this.entries[emitted++]
          onEntry?.({ name, size, type })
        }
      }
      emitAvailable()
      while (!this.exhausted && this.entries.length <= end) {
        await this.scanNext(options)
        emitAvailable()
      }
      return {
        entries: this.entries.slice(offset, end).map(({ name, size, type }) => ({ name, size, type })),
        hasMore: this.entries.length > end,
      }
    })
  }

  async find(name: string, signal?: AbortSignal): Promise<IndexedTarEntry | null> {
    return this.serialize(async () => {
      while (!this.entriesByName.has(name) && !this.exhausted) await this.scanNext({ signal })
      return this.entriesByName.get(name) ?? null
    })
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending
    let release!: () => void
    this.pending = new Promise(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  private async bytesAt(at: number, length: number, options: Pick<RangeOptions, 'signal' | 'onProgress'>): Promise<Buffer> {
    options.signal?.throwIfAborted()
    if (this.chunk && at >= this.chunk.start && at + length <= this.chunk.start + this.chunk.buffer.length) {
      return this.chunk.buffer.subarray(at - this.chunk.start, at - this.chunk.start + length)
    }
    const buffer = await this.read(at, Math.max(length, HEADER_CHUNK_BYTES), options.signal)
    this.chunk = { start: at, buffer }
    options.onProgress?.({ bytes: buffer.length, requests: 1 })
    return buffer.subarray(0, length)
  }

  private async scanNext(options: Pick<RangeOptions, 'signal' | 'onProgress'>): Promise<void> {
    const header = await this.bytesAt(this.position, TAR_BLOCK_SIZE, options)
    if (header.length === 0) { this.exhausted = true; return }
    const parsed = decodeTarHeader(header)
    if (!parsed) { this.exhausted = true; return }
    const bodyOffset = this.position + TAR_BLOCK_SIZE

    if (['x', 'g', 'L', 'K'].includes(parsed.type)) {
      await this.readMetadata(parsed, bodyOffset, options)
      this.position = bodyOffset + Math.ceil(parsed.size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
      return
    }

    const attributes = { ...this.globalPax, ...this.localPax }
    const name = attributes.path ?? this.longName ?? parsed.name
    const size = attributes.size == null ? parsed.size : Number(attributes.size)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid PAX file size')
    // Sparse tarの本文は元のファイルと異なるため、そのまま配信しない。
    const type = Object.keys(attributes).some(key => key.startsWith('GNU.sparse.')) ? 'sparse' : parsed.type
    const nextPosition = bodyOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
    if (!Number.isSafeInteger(nextPosition)) throw new Error('tar offset exceeds safe integer range')
    this.position = nextPosition
    this.localPax = {}
    this.longName = null
    if (isMacOsMetadata(name)) return
    const entry = { name, size, type, bodyOffset }
    this.entries.push(entry)
    // 本文抽出と同じく、同名のエントリは最初のものを開く。
    if (!this.entriesByName.has(name)) this.entriesByName.set(name, entry)
  }

  private async readMetadata(parsed: TarEntry, bodyOffset: number, options: Pick<RangeOptions, 'signal' | 'onProgress'>): Promise<void> {
    if (parsed.type === 'K') return
    if (parsed.size > MAX_METADATA_BYTES) throw new Error('tar metadata exceeds size limit')
    const body = await this.bytesAt(bodyOffset, parsed.size, options)
    if (body.length !== parsed.size) throw new Error('incomplete tar metadata')
    if (parsed.type === 'L') { this.longName = decodeTarString(body); return }
    const attributes = decodePaxAttributes(body)
    if (parsed.type === 'g') this.globalPax = { ...this.globalPax, ...attributes }
    else this.localPax = { ...this.localPax, ...attributes }
  }
}

export async function listTarHeadersByRange(read: RangeReader, options: RangeOptions, onEntry?: (entry: TarEntry) => void): Promise<RangeListing> {
  return new TarRangeIndex(read).list(options, onEntry)
}
