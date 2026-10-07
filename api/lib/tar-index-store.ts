import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { chmodSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { IndexedTarEntry } from './tar-range.js'
import { createPrivateMediaDirectory } from './media-temporary-directory.js'

// 索引は本文を保存しない再生成可能なcache。RAMは2MiB、diskは1索引512MiBまで。
const SQLITE_CACHE_KIB = 2048
const SQLITE_PAGE_BYTES = 4096
const MAX_INDEX_FILE_BYTES = 512 * 1024 * 1024
// B-treeのページ分割・UTF-8名の重複分を見込み、物理上限より早く止める。
const MAX_ENTRY_DATA_BYTES = MAX_INDEX_FILE_BYTES / 4
const ENTRY_OVERHEAD_BYTES = 128
// 100件の一覧に巨大なPAX名を展開してNode heapを使い切らない。
const MAX_ENTRY_NAME_BYTES = 16 * 1024

export class TarIndexLimitError extends Error {
  constructor(message = 'tar index exceeds storage limit') { super(message); this.name = 'TarIndexLimitError' }
}

export class TarIndexStore {
  private readonly directory = createPrivateMediaDirectory('tar-index')
  private readonly path = join(this.directory, 'index.sqlite')
  private readonly database: DatabaseSync
  private readonly insert: StatementSync
  private readonly byName: StatementSync
  private readonly page: StatementSync
  private closed = false
  private count = 0
  private entryBytes = 0
  private failure: Error | null = null

  constructor() {
    let opened: DatabaseSync | undefined
    try {
      this.database = opened = new DatabaseSync(this.path)
      chmodSync(this.directory, 0o700)
      chmodSync(this.path, 0o600)
      this.database.exec(`
        PRAGMA page_size=${SQLITE_PAGE_BYTES};
        PRAGMA cache_size=-${SQLITE_CACHE_KIB};
        PRAGMA max_page_count=${MAX_INDEX_FILE_BYTES / SQLITE_PAGE_BYTES};
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        CREATE TABLE entries (ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, body_offset INTEGER NOT NULL);
        CREATE INDEX entry_names ON entries (name, ordinal);
      `)
      this.insert = this.database.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)')
      this.byName = this.database.prepare('SELECT name, size, type, body_offset FROM entries WHERE name = ? ORDER BY ordinal LIMIT 1')
      this.page = this.database.prepare('SELECT name, size, type, body_offset FROM entries WHERE ordinal >= ? AND ordinal < ? ORDER BY ordinal')
    } catch (error) {
      opened?.close()
      rmSync(this.directory, { recursive: true, force: true })
      throw error
    }
  }

  get entryCount(): number { return this.count }
  get diskBytes(): number { return this.closed ? 0 : statSync(this.path).size }
  begin(): void { this.assertAvailable(); this.database.exec('BEGIN') }
  commit(): void {
    if (this.failure) return
    try { this.database.exec('COMMIT') } catch (error) { this.failure = error as Error; throw error }
  }

  append(entry: IndexedTarEntry): void {
    this.assertAvailable()
    const nameBytes = Buffer.byteLength(entry.name)
    if (nameBytes > MAX_ENTRY_NAME_BYTES) throw new TarIndexLimitError('tar entry name exceeds size limit')
    const bytes = ENTRY_OVERHEAD_BYTES + nameBytes * 2 + Buffer.byteLength(entry.type)
    if (this.entryBytes + bytes > MAX_ENTRY_DATA_BYTES) throw new TarIndexLimitError()
    try { this.insert.run(this.count, entry.name, entry.size, entry.type, entry.bodyOffset) } catch (error) {
      // SQLITE_FULLなどの自動rollback後に、途中の索引を正常な一覧として返さない。
      this.failure = (error as { errcode?: number }).errcode === 13 ? new TarIndexLimitError() : error as Error
      throw this.failure
    }
    this.entryBytes += bytes
    this.count++
  }

  find(name: string): IndexedTarEntry | null {
    this.assertAvailable()
    const row = this.byName.get(name)
    return row ? this.decode(row) : null
  }

  list(offset: number, end: number): IndexedTarEntry[] {
    this.assertAvailable()
    return this.page.all(offset, end).map(row => this.decode(row))
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
    rmSync(this.directory, { recursive: true, force: true })
  }

  private decode(row: Record<string, unknown>): IndexedTarEntry {
    return { name: String(row.name), size: Number(row.size), type: String(row.type), bodyOffset: Number(row.body_offset) }
  }

  private assertAvailable(): void { if (this.failure) throw this.failure }
}
