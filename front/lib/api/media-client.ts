import { MediaAnalyze } from './types'
import { buildUrl, fetchOk, storagePath } from './http'

// 音声解析 (波形ピーク + スペクトログラム有無)。サーバー側でキャッシュされる
// ため TTLCache には入れない。長尺ファイルはレスポンスまで数十秒かかりうる —
// 呼び出し側は AbortSignal でアンマウント時に中断すること。
export const mediaClient = {
  mediaAnalyze: async (
    connectionId: string,
    bucket: string,
    key: string,
    opts: { entryPath?: string; signal?: AbortSignal } = {},
  ) => {
    const res = await fetchOk(
      buildUrl(storagePath(connectionId, '/media/analyze'), { bucket, key, entryPath: opts.entryPath }),
      { headers: { Accept: 'application/json' }, signal: opts.signal },
    )
    return MediaAnalyze.parse(await res.json())
  },

  spectrogramUrl: (connectionId: string, cacheKey: string): string =>
    buildUrl(storagePath(connectionId, '/media/spectrogram'), { cacheKey }),
}
