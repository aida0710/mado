import type { Context, Hono } from 'hono'
import { detectArchive, extractTarEntry } from '../lib/tar-stream.js'
import type { TarIndexCache } from '../lib/tar-index-cache.js'
import { parseByteRange } from '../lib/byte-range.js'
import { entryContentType } from '../lib/preview-mime.js'
import { resolveObjectOrFail, type GetStorage, type ObjectRequest } from './_storageRequest.js'
import { openObject, storageError, streamObject } from './_storageResponse.js'

interface TarEntryRouteDeps {
  getStorage: GetStorage
  maxBytes: number
  tarIndexes: TarIndexCache
}

function parsePositiveInteger(raw: string | undefined): number | null {
  if (raw == null) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

async function streamTarEntry(c: Context, object: ObjectRequest, options: {
  entryName: string
  headBytes: number | null
  tarIndexes: TarIndexCache
}): Promise<Response> {
  const signal = c.req.raw.signal
  const archive = await options.tarIndexes.open({ ...object, signal })
  const entry = await archive.index.find(options.entryName, signal)
  if (!entry) return c.json({ error: `entry not found: ${options.entryName}` }, 404)
  if (entry.type !== 'file') return c.json({ error: 'entry is not a regular file' }, 400)
  if (entry.bodyOffset + entry.size > archive.size) throw new Error('incomplete tar entry')

  const rangeHeader = options.headBytes == null && c.req.method === 'GET' ? c.req.header('Range') : undefined
  const range = rangeHeader ? parseByteRange(rangeHeader, entry.size) : null
  if (rangeHeader && !range) {
    return new Response(null, { status: 416, headers: {
      'Content-Range': `bytes */${entry.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    } })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? Math.min(options.headBytes ?? entry.size, entry.size) - 1
  const contentLength = Math.max(0, end - start + 1)
  const headers: Record<string, string> = {
    'Content-Type': entryContentType(entry.name),
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${entry.size}`
  if (options.headBytes != null && end + 1 < entry.size) headers['X-Preview-Truncated'] = '1'
  const status = range ? 206 : 200
  if (c.req.method === 'HEAD' || contentLength === 0) return new Response(null, { status, headers })

  const archiveStart = entry.bodyOffset + start
  const archiveEnd = entry.bodyOffset + end
  const opened = await openObject(c, object, { range: `bytes=${archiveStart}-${archiveEnd}`, etag: archive.etag, signal })
  if (opened instanceof Response) return opened
  // tar全体のContent-Rangeではなく、エントリ自身の範囲をブラウザへ返す。
  if (opened.contentRange !== `bytes ${archiveStart}-${archiveEnd}/${archive.size}` || opened.contentLength !== contentLength) {
    opened.body.destroy()
    throw new Error('storage did not return the requested entry range')
  }
  return streamObject({ ...opened, contentRange: headers['Content-Range'] }, headers)
}

export function mountStorageTarEntryRoute(app: Hono, deps: TarEntryRouteDeps): void {
  app.on(['GET', 'HEAD'], '/storage/:connectionId/preview/tar-entry', async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const entryName = c.req.query('entry')
    if (!entryName) return c.json({ error: 'bucket, key and entry are required' }, 400)
    const kind = detectArchive(object.key)
    if (!kind) return c.json({ error: 'unsupported archive extension' }, 400)
    const requestedHeadBytes = parsePositiveInteger(c.req.query('maxBytes'))
    const headBytes = requestedHeadBytes == null ? null : Math.min(requestedHeadBytes, deps.maxBytes)

    try {
      if (kind === 'tar') return await streamTarEntry(c, object, { entryName, headBytes, tarIndexes: deps.tarIndexes })

      const opened = await openObject(c, object)
      if (opened instanceof Response) return opened
      const extracted = await extractTarEntry({ source: opened.body, kind, entryName, byteLimit: headBytes ?? deps.maxBytes })
      if (!extracted) return c.json({ error: `entry not found: ${entryName}` }, 404)
      if (extracted.truncated && headBytes == null) {
        return c.json({ error: `entry exceeds preview limit (${deps.maxBytes} bytes)` }, 413)
      }
      const body = new Uint8Array(extracted.buffer)
      return new Response(body, { headers: {
        'Content-Type': entryContentType(entryName),
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'private, no-store',
        ...(extracted.truncated ? { 'X-Preview-Truncated': '1' } : {}),
      } })
    } catch (error) {
      return storageError(c, error)
    }
  })
}
