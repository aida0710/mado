import type { z } from 'zod'
import { TarPreview } from './types'
import { fetchOk } from './http'
import { MAX_TAR_PREPARATION_MS, waitForTarPreparationRetry } from '../prepareTarEntry'
import { mediaMessages } from '../mediaMessages'

export type TarEntry = z.infer<typeof TarPreview>['entries'][number]

export interface TarPreviewCallbacks {
  onMode?: (mode: 'range' | 'stream') => void
  onEntry?: (entry: TarEntry) => void
  onProgress?: (progress: { bytes: number; requests?: number }) => void
}

interface TarDone {
  truncated: boolean
  hasMore: boolean
  offset: number
  limit: number
}

/** NDJSON で流れてくる tar の一覧を読み切って TarPreview に組み立てる。各行は以下のいずれか:
 *    {"mode":"range"|"stream"} / {"entry":{name,size,type}} / {"progress":{bytes,requests?}}
 *    {"done":{truncated,hasMore,offset,limit}} / {"error":"..."}
 *  種別ごとにコールバックするため、ストリーム中に UI が「X 件 / Y MB / mode」を出せる。 */
async function readTarPreviewStream(res: Response, callbacks: TarPreviewCallbacks): Promise<z.infer<typeof TarPreview>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const entries: TarEntry[] = []
  let done: TarDone | null = null
  let pending = ''
  let preparing = false

  const handleLine = (line: string): void => {
    if (line.length === 0) return
    const record = JSON.parse(line) as Record<string, unknown>
    if ('mode' in record) {
      callbacks.onMode?.(record.mode as 'range' | 'stream')
    } else if ('entry' in record) {
      const entry = record.entry as TarEntry
      entries.push(entry)
      callbacks.onEntry?.(entry)
    } else if ('progress' in record) {
      callbacks.onProgress?.(record.progress as { bytes: number; requests?: number })
    } else if ('done' in record) {
      done = record.done as TarDone
    } else if (record.pending === true) {
      preparing = true
    } else if ('error' in record) {
      throw new Error(String(record.error))
    }
  }

  try {
    while (true) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      pending += decoder.decode(value, { stream: true })
      // chunk ごとに分割: 最後の要素は incomplete 行なので pending に戻す。
      // 完了行 (\n 終端) のみを順に処理する。
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    pending += decoder.decode()
    if (pending.trim()) handleLine(pending)
  } finally { await reader.cancel().catch(() => {}) }
  if (preparing) throw new TarPreviewPendingError()
  // closure (handleLine) 経由で代入するので TS は narrow できない。
  // ここまで来れば必ず TarDone が入っていることを assert する。
  if (!done) throw new Error('tar stream ended without done marker')
  const finalDone: TarDone = done
  return TarPreview.parse({ entries, ...finalDone })
}

class TarPreviewPendingError extends Error {}

// 各要求の走査量を区切り、取得済みの一覧を重複表示せずに続きを準備する。
export async function loadTarPreviewStream(url: string, callbacks: TarPreviewCallbacks): Promise<z.infer<typeof TarPreview>> {
  const deadline = Date.now() + MAX_TAR_PREPARATION_MS
  const emitted: TarEntry[] = []
  for (;;) {
    let ordinal = 0
    try {
      const preview = await readTarPreviewStream(await fetchOk(url), {
        ...callbacks,
        onEntry: entry => {
          const previous = emitted[ordinal++]
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error(mediaMessages.archiveChanged)
            return
          }
          emitted.push(entry)
          callbacks.onEntry?.(entry)
        },
      })
      if (preview.entries.length !== emitted.length) throw new Error(mediaMessages.archiveChanged)
      return preview
    } catch (error) {
      if (!(error instanceof TarPreviewPendingError)) throw error
      if (Date.now() >= deadline) throw new Error(mediaMessages.tarPreparationTimeout, { cause: error })
      await waitForTarPreparationRetry()
    }
  }
}
