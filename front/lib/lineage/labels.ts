import type { LineageNodeKind } from '../api/types'

export const LINEAGE_KIND_LABEL: Record<LineageNodeKind, string> = {
  source: '入手元',
  dataset: 'データセット',
  job: '処理',
  version: 'バージョン',
  run: '実行履歴',
  location: '保存場所',
}

const STATUS_LABELS: Record<string, string> = {
  start: '実行中',
  starting: '開始中',
  running: '実行中',
  complete: '完了',
  completed: '完了',
  fail: '失敗',
  failed: '失敗',
  abort: '中断',
  aborted: '中断',
  available: '利用可能',
  archived: 'アーカイブ済み',
  missing: '見つかりません',
  deleted: '削除済み',
  unknown: '不明',
}

export function lineageStatusLabel(value: string | null | undefined): string | null {
  if (!value) return null
  return STATUS_LABELS[value.toLowerCase()] ?? value
}

export function lineageCompletenessLabel(value: string | null | undefined): string | null {
  if (value === 'complete') return '台帳登録済み'
  if (value === 'partial') return '一部のみ台帳登録済み'
  if (value === 'unregistered') return '台帳未登録'
  return value ?? null
}

export function lineageSourceKindLabel(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return ({
    purchased: '購入',
    crawled: '収集',
    provided: '提供',
    generated: '生成',
    database: 'データベース',
    other: 'その他',
  } as Record<string, string>)[value.toLowerCase()] ?? value
}

export function projectionStateLabel(value: string): string {
  return ({
    synced: '反映済み',
    lagging: '反映待ち',
    unavailable: '反映サービス停止中',
  } as Record<string, string>)[value.toLowerCase()] ?? value
}
