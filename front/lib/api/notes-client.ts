import type { z } from 'zod'
import { Note, NoteHistoryList, NoteHistoryVersion, PutNoteOk } from './types'
import { API_BASE, buildUrl, getJson, mutateJson } from './http'

const notePath = (slug: string) => `${API_BASE}/notes/${encodeURIComponent(slug)}`

// Team note (postgres notes テーブル)。Mado 全体で 1 つの共有 Markdown。
export const notesClient = {
  note: (slug: string) => getJson(notePath(slug), Note),

  putNote: (slug: string, body: string, editor: string): Promise<z.infer<typeof PutNoteOk>> =>
    mutateJson(notePath(slug), { method: 'PUT', body: { body, editor } }, PutNoteOk),

  // 編集履歴 (新しい順)。
  noteHistory: (slug: string, limit?: number) =>
    getJson(buildUrl(`${notePath(slug)}/history`, {
      limit: limit != null ? String(limit) : undefined,
    }), NoteHistoryList),

  noteHistoryVersion: (slug: string, id: number) =>
    getJson(`${notePath(slug)}/history/${id}`, NoteHistoryVersion),
}
