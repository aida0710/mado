import { isMacOsMetadata, type TarEntry } from './tar-stream.js'
import { decodePaxAttributes, decodeTarHeader, decodeTarString, TAR_BLOCK_SIZE } from './tar-header.js'
import { TarIndexStore } from './tar-index-store.js'
import { TarScanBudget, TarScanPendingError } from './tar-scan-budget.js'
import { createSemaphore } from './semaphore.js'

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

// GCでもsqliteのハンドルと一時ファイルを回収する。明示的な解放はcache側でも行う。
const stores = new FinalizationRegistry<TarIndexStore>(store => store.close())

// 小さなJSONと隣接するヘッダーはまとめて読み、大きな本文は読み飛ばす。
const HEADER_CHUNK_BYTES = 256 * 1024
// 長名/PAXだけをバッファする。通常は数KBで、1MiB以上はメタデータとして受け付けない。
const MAX_METADATA_BYTES = 1024 * 1024

export type RangeReader = (start: number, length: number, signal?: AbortSignal) => Promise<Buffer>

/** ヘッダーの位置を順次記録し、一覧と本文取得で同じ索引を使う。 */
export class TarRangeIndex {
  private readonly store = new TarIndexStore()
  private position = 0
  private exhausted = false
  private chunk: { start: number; buffer: Buffer } | null = null
  private globalPax: Record<string, string> = {}
  private localPax: Record<string, string> = {}
  private longName: string | null = null
  private readonly operations = createSemaphore(1, 16)
  private budget: TarScanBudget | null = null

  constructor(private readonly read: RangeReader) { stores.register(this, this.store, this) }

  get entryCount(): number { return this.store.entryCount }
  get diskBytes(): number { return this.store.diskBytes }
  close(): void { stores.unregister(this); this.store.close() }

  async list(options: RangeOptions, onEntry?: (entry: TarEntry) => void): Promise<RangeListing> {
    return this.serialize(async () => {
      const offset = options.offset ?? 0
      const end = offset + options.entryLimit
      let emitted = offset
      const emitAvailable = (): void => {
        for (const { name, size, type } of this.store.list(emitted, Math.min(end, this.entryCount))) {
          emitted++
          onEntry?.({ name, size, type })
        }
      }
      emitAvailable()
      while (!this.exhausted && this.entryCount <= end) {
        await this.scanNext(options)
        emitAvailable()
      }
      return {
        entries: this.store.list(offset, end).map(({ name, size, type }) => ({ name, size, type })),
        hasMore: this.entryCount > end,
      }
    }, options.signal)
  }

  async find(name: string, signal?: AbortSignal): Promise<IndexedTarEntry | null> {
    signal?.throwIfAborted()
    const cached = this.store.find(name)
    if (cached || this.exhausted) return cached
    return this.serialize(async () => {
      while (!this.store.find(name) && !this.exhausted) await this.scanNext({ signal })
      return this.store.find(name)
    }, signal)
  }

  private async serialize<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.operations.acquire(signal)
    try {
      this.budget = new TarScanBudget()
      this.store.begin()
      try { return await operation() } finally { this.store.commit() }
    } finally { this.budget = null; release() }
  }

  private async bytesAt(at: number, length: number, options: Pick<RangeOptions, 'signal' | 'onProgress'>): Promise<Buffer> {
    options.signal?.throwIfAborted()
    if (this.chunk && at >= this.chunk.start && at + length <= this.chunk.start + this.chunk.buffer.length) {
      return this.chunk.buffer.subarray(at - this.chunk.start, at - this.chunk.start + length)
    }
    const requestBytes = Math.max(length, HEADER_CHUNK_BYTES)
    this.budget!.request(requestBytes)
    const signal = options.signal ? AbortSignal.any([options.signal, this.budget!.timeout]) : this.budget!.timeout
    let buffer: Buffer
    try { buffer = await this.read(at, requestBytes, signal) } catch (error) {
      if (this.budget!.timeout.aborted && !options.signal?.aborted) throw new TarScanPendingError()
      throw error
    }
    this.chunk = { start: at, buffer }
    options.onProgress?.({ bytes: buffer.length, requests: 1 })
    return buffer.subarray(0, length)
  }

  private async scanNext(options: Pick<RangeOptions, 'signal' | 'onProgress'>): Promise<void> {
    this.budget!.header()
    const header = await this.bytesAt(this.position, TAR_BLOCK_SIZE, options)
    if (header.length === 0) { this.exhausted = true; return }
    const parsed = decodeTarHeader(header)
    if (!parsed) { this.exhausted = true; return }
    const bodyOffset = this.position + TAR_BLOCK_SIZE
    const headerEnd = bodyOffset + Math.ceil(parsed.size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
    if (!Number.isSafeInteger(headerEnd)) throw new Error('tar offset exceeds safe integer range')

    if (['x', 'g', 'L', 'K'].includes(parsed.type)) {
      await this.readMetadata(parsed, bodyOffset, options)
      this.position = headerEnd
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
    const entry = { name, size, type, bodyOffset }
    if (!isMacOsMetadata(name)) this.store.append(entry)
    this.position = nextPosition
    this.localPax = {}
    this.longName = null
  }

  private async readMetadata(parsed: TarEntry, bodyOffset: number, options: Pick<RangeOptions, 'signal' | 'onProgress'>): Promise<void> {
    if (parsed.type === 'K') return
    if (parsed.size > MAX_METADATA_BYTES) throw new Error('tar metadata exceeds size limit')
    const body = await this.bytesAt(bodyOffset, parsed.size, options)
    if (body.length !== parsed.size) throw new Error('incomplete tar metadata')
    if (parsed.type === 'L') { this.longName = decodeTarString(body); return }
    const attributes = decodePaxAttributes(body)
    const combined = { ...(parsed.type === 'g' ? this.globalPax : this.localPax), ...attributes }
    if (Buffer.byteLength(JSON.stringify(combined)) > MAX_METADATA_BYTES) throw new Error('tar metadata exceeds size limit')
    if (parsed.type === 'g') this.globalPax = combined
    else this.localPax = combined
  }
}

export async function listTarHeadersByRange(read: RangeReader, options: RangeOptions, onEntry?: (entry: TarEntry) => void): Promise<RangeListing> {
  const index = new TarRangeIndex(read)
  try { return await index.list(options, onEntry) } finally { index.close() }
}
