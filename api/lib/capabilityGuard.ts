import type { Context, MiddlewareHandler, Next } from 'hono'
import type { Capability, ConnectionConfig } from '../storage.js'

export type GetConnectionConfig = (connId: string) => Promise<ConnectionConfig>

/** 権限ごとの日本語ラベル。403 のメッセージに使う (UI がボタンを隠していても
 *  共有 Web URL を直に開いた人には理由が見えるように)。front 側の
 *  CAPABILITY_LABELS と文言を揃えること。 */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  list:             'バケット / オブジェクトの一覧',
  preview:          'ファイルのプレビュー',
  download:         'ファイルのダウンロード',
  archive:          '圧縮ファイルを開く',
  audioInfo:        '音声情報の表示',
  audioSpectrogram: 'スペクトログラムの表示',
  readmeRead:       'README の読み込み',
  readmeWrite:      'README の編集',
}

/**
 * `:connId` の接続で `cap` が有効かを確認する Hono ミドルウェア。
 *
 * ルート側のハンドラには一切手を入れず、internal.ts でパスごとに mount する
 * — 「どのエンドポイントがどの権限に属するか」を 1 箇所で読めるようにするため。
 * mount はルート登録より **前** に行うこと (Hono は登録順に実行する)。
 *
 * 接続設定は storage factory のキャッシュ (S3Client と同じ 1 行) から読むので、
 * 1 リクエスト増えるごとの DB アクセスは発生しない。
 */
export function requireCapability(
  cap: Capability,
  getConnectionConfig: GetConnectionConfig,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const connId = c.req.param('connId')
    if (!connId) return c.json({ error: 'connId required' }, 400)

    let config: ConnectionConfig
    try {
      config = await getConnectionConfig(connId)
    } catch (e) {
      if (e instanceof Error && (e as { code?: string }).code === 'NOT_FOUND') {
        return c.json({ error: 'connection not found' }, 404)
      }
      throw e
    }

    if (!config.capabilities[cap]) {
      // 403: 認証の失敗 (401) ではなく「この接続では無効にされている」。
      return c.json(
        { error: `この接続では「${CAPABILITY_LABELS[cap]}」が無効になっています`, capability: cap },
        403,
      )
    }
    await next()
  }
}
