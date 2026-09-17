import { Job, StartScanOk } from './types'
import { API_BASE, buildUrl, errorFromResponse, getJson, mutateJson, storagePath } from './http'

// 走査ジョブ (spec: 2026-08-18-directory-scan-design.md)。
// 走査は重く状態をサーバーが持つので、TTLCache は通さない。
export const jobsClient = {
  startScan: (connectionId: string, bucket: string, prefix: string) =>
    mutateJson(buildUrl(storagePath(connectionId, '/scan'), { bucket, prefix }), { method: 'POST' }, StartScanOk),

  getJob: (id: number) => getJson(`${API_BASE}/jobs/${id}`, Job),

  /** 最後に成功した走査結果。無ければ null。 */
  latestScan: async (connectionId: string, bucket: string, prefix: string) => {
    const dedupKey = `${connectionId}\n${bucket}\n${prefix}`
    const res = await fetch(
      buildUrl(`${API_BASE}/jobs/latest`, { kind: 'storage.scan', dedupKey }),
      { headers: { Accept: 'application/json' } },
    )
    if (res.status === 404) return null
    if (!res.ok) throw await errorFromResponse(res)
    return Job.parse(await res.json())
  },

  cancelJob: async (id: number): Promise<void> => {
    await mutateJson(`${API_BASE}/jobs/${id}/cancel`, { method: 'POST' }, null)
  },
}
