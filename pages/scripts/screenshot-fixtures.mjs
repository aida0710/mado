// 公開画像には架空の接続・データだけを使い、APIリクエストはすべてブラウザ内で応答する。
export const SAMPLE_PREFIX = 'samples/'
export const SAMPLE_BUCKET = 'audio-datasets'

const capturedAt = new Date().toISOString()
const pricing = {
  provider: 'onprem', providerExplicit: true, region: null, storageClass: null,
  storageClassLabel: null, ratesResolved: true, readMbps: 300, writeMbps: 300,
  parallelism: 16, requestOverheadMs: 20, instability: 0.5,
  capacityBytes: 50 * 1024 ** 4, storagePerGbMonth: null, egressPerGb: null,
  putPer1000: null, getPer1000: null,
  effective: {
    storagePerGbMonth: null, egressPerGb: null, putPer1000: 0, getPer1000: 0,
    retrievalPerGb: 0, minDurationDays: 0, minBillableBytes: 0,
    perObjectOverheadBytes: 0, storageRateSource: 'none',
  },
}
const capabilities = Object.fromEntries([
  'list', 'preview', 'download', 'archive', 'audioInfo', 'audioSpectrogram', 'readmeRead', 'readmeWrite',
].map(name => [name, true]))

export const connections = [
  { id: 'demo', name: 'Research storage', endpoint: 'https://s3.example.com', isDefault: true },
  { id: 'archive', name: 'Archive storage', endpoint: 'https://archive.example.com', isDefault: false },
  { id: 'aws', name: 'AWS S3', endpoint: 'https://s3.ap-northeast-1.amazonaws.com', isDefault: false },
].map(connection => ({
  ...connection, region: 'ap-northeast-1', accessKeyIdMasked: '********DEMO',
  forcePathStyle: true, listObjectsVersion: 'v2', capabilities, scanEnabled: true,
  scanPageSize: 1000, listCacheTtlSec: 86400, capacityMetricsEnabled: true,
  capacityTracking: { enabled: true, intervalSeconds: 21600 }, pricing,
  visibility: { mode: 'public', allowedUsers: [] }, createdAt: capturedAt, updatedAt: capturedAt,
}))

const permissions = [
  'connections:manage', 'users:manage', 'service_accounts:manage', 'audit:read',
  'settings:manage', 'storage:read', 'storage:download', 'storage:write',
  'content:write', 'lineage:read', 'lineage:curate', 'jobs:operate', 'tags:manage',
]
const user = {
  id: 'sample-admin', username: 'demo-admin', email: 'admin@example.com',
  displayName: 'Sample admin', signatureName: 'Sample team', roles: ['admin'],
  permissions, mustChangePassword: false, authMethods: ['local'],
}

export const readmeBody = `# 音声データのサンプル

元の音声と処理後の音声を比較するためのサンプルです。

| ファイル | 内容 |
| --- | --- |
| original.wav | 元の音声 · 48 kHz / mono |
| processed.wav | ノイズ除去後の音声 |
| metadata.json | サンプルの情報と処理条件 |

音声は同期プレイヤーに追加して、同じ位置から聴き比べてください。`

const noteBody = `# データの置き場所

このノートに、共有ストレージの使い方と作業のメモを残しています。

## ストレージ

| 接続 | 用途 |
| --- | --- |
| Research storage | 作業中のデータと音声サンプル |
| Archive storage | 処理が終わったデータの保管 |
| AWS S3 | 外部サービスとやり取りするデータ |

## 音声を確認する

1. **Storage** から **audio-datasets / samples/** を開きます。
2. 元の音声と処理後の音声を、同期プレイヤーに追加します。
3. 同じ位置から再生して、波形と音を確認します。

## データを追加したら

ディレクトリのREADMEに、内容・形式・処理条件を記録してください。
処理のつながりは **DataLineage** から確認できます。`

const filenames = [
  ['metadata.json', 2184], ['original.wav', 1152044], ['processed.wav', 1152044],
  ['spectrogram.png', 102400], ['sample.mp4', 1048576000], ['dataset-00001.tar', 17179869184],
  ['manifest.jsonl', 32768], ['README.md', 620],
]
const scan = {
  objectCount: 12408, totalBytes: 86419753200, partial: false,
  children: [
    { name: 'train/', objectCount: 10124, totalBytes: 68419753200 },
    { name: 'validation/', objectCount: 1484, totalBytes: 12000000000 },
    { name: 'test/', objectCount: 800, totalBytes: 6000000000 },
  ],
  extensions: [
    { ext: '.wav', objectCount: 6200, totalBytes: 68000000000 },
    { ext: '.json', objectCount: 6200, totalBytes: 419753200 },
    { ext: '.tar', objectCount: 8, totalBytes: 18000000000 },
  ],
}
const scanJob = { id: 1, status: 'done', progress: null, result: scan, finishedAt: capturedAt, error: null }
const tags = [
  { id: 'audio', name: '音声', color: '#6b7f62' },
  { id: 'ready', name: '確認済み', color: '#6e7f98' },
  { id: 'working', name: '処理中', color: '#a67a45' },
]

const registryDatasets = [
  { datasetId: 'raw', name: 'raw-audio', displayName: '元の音声', description: '収録時の音声データ', versionCount: 1 },
  { datasetId: 'clean', name: 'clean-audio', displayName: 'ノイズ除去後', description: 'ノイズを取り除いた音声', versionCount: 3 },
  { datasetId: 'segments', name: 'audio-segments', displayName: '分割した音声', description: '発話ごとに分割した音声', versionCount: 2 },
].map(dataset => ({ ...dataset, kind: 'dataset', datasetKey: dataset.name, namespace: 'sample-audio', aliases: [], mediaType: 'audio/wav', owner: 'Sample team', currentVersionId: `${dataset.datasetId}-v1` }))

const lineageGraph = {
  nodes: [
    { id: 'raw', kind: 'dataset', label: '元の音声', registry: registryDatasets[0], namespace: 'sample-audio', name: 'raw-audio' },
    { id: 'denoise', kind: 'job', label: 'ノイズ除去', namespace: 'sample-pipeline', name: 'denoise', summary: { description: '音声から背景ノイズを除去' } },
    { id: 'clean', kind: 'dataset', label: 'ノイズ除去後', registry: registryDatasets[1], namespace: 'sample-audio', name: 'clean-audio' },
  ].map(node => ({ ...node, data: {}, summary: node.summary ?? {}, completeness: 'complete', updatedAt: capturedAt })),
  edges: [
    { id: 'a', source: 'raw', target: 'denoise', kind: 'input' },
    { id: 'b', source: 'denoise', target: 'clean', kind: 'output' },
  ],
  projection: { state: 'synced', pendingEvents: 0 }, generatedAt: capturedAt, truncated: false, warnings: [],
}

function capacityOverview(days) {
  const bucketNames = ['audio-datasets', 'training-data', 'results']
  return {
    connectionId: 'demo', days, capacityBytes: 50 * 1024 ** 4,
    tracking: { enabled: true, intervalSeconds: 21600, nextRunAt: new Date(Date.now() + 21600000).toISOString(), lastAttemptAt: capturedAt, lastStatus: 'waiting', lastError: null, consecutiveFailures: 0 },
    scan: { jobs: [] },
    buckets: bucketNames.map((bucket, bucketIndex) => ({
      bucket, lastSuccessAt: capturedAt, lastStatus: 'success', lastError: null,
      points: Array.from({ length: 56 }, (_, measurement) => ({ totalBytes: (2.8 + bucketIndex * 1.3 + measurement * 0.024 + Math.sin(measurement / 4) * 0.08) * 1024 ** 4, objectCount: 360000 + bucketIndex * 210000 + measurement * 4550, collectedAt: new Date(Date.now() - (55 - measurement) * 21600000).toISOString() })),
      prefixes: ['train/', 'validation/', 'test/'].map((prefix, index) => ({ prefix, totalBytes: (2.2 - index * 0.9) * 1024 ** 4, objectCount: 230000 - index * 72000, previous: { totalBytes: (2.1 - index * 0.9) * 1024 ** 4, objectCount: 216000 - index * 70000 } })),
    })),
  }
}

function transferEstimate() {
  return {
    source: { connectionId: 'demo', name: 'Research storage', provider: 'onprem', storageClass: null, storageClassLabel: null },
    scan: { objectCount: scan.objectCount, totalBytes: scan.totalBytes, scannedAt: capturedAt },
    catalog: { asOf: '2026-10-08', awsPublishedAt: null, source: 'bundled', fetchedAt: null, stale: false, manualFacts: { verifiedOn: '2026-10-08', notes: ['スクリーンショット用のサンプル見積もり'], sources: [] } },
    candidates: [
      { connectionId: 'archive', name: 'Archive storage', provider: 'onprem', storageClass: null, storageClassLabel: null, sameConnection: false, durationSec: { optimistic: 2304, pessimistic: 4608 }, upfront: { egress: 0, retrieval: 0, getRequests: 0, putRequests: 0, total: 0 }, monthlyUsd: 0, billableBytes: scan.totalBytes, putRequestCount: scan.objectCount, avgObjectBytes: scan.totalBytes / scan.objectCount, warnings: [] },
      { connectionId: 'aws', name: 'AWS S3', provider: 'aws', storageClass: 'STANDARD', storageClassLabel: 'S3 Standard', sameConnection: false, durationSec: { optimistic: 3456, pessimistic: 6912 }, upfront: { egress: 0, retrieval: 0, getRequests: 0, putRequests: 0.06, total: 0.06 }, monthlyUsd: 2.02, billableBytes: scan.totalBytes, putRequestCount: scan.objectCount, avgObjectBytes: scan.totalBytes / scan.objectCount, warnings: [] },
    ],
  }
}

export async function fulfillSampleApi({ route, media, login = false, unhandled }) {
  const url = new URL(route.request().url())
  const path = url.pathname
  const suffix = path.replace(/^\/api\/internal\/storage\/[^/]+/, '')
  const sendJson = body => route.fulfill({ json: body })

  if (path === '/api/auth/config') return sendJson({ localEnabled: true, oidc: { enabled: true, id: 'sample', label: 'SSO' } })
  if (path === '/api/auth/me') return login ? route.fulfill({ status: 401, json: {} }) : sendJson({ user })
  if (path === '/api/internal/connections') return sendJson(connections)
  if (path === '/api/internal/connections/access-users') return sendJson({ users: [] })
  if (path === '/api/internal/settings') return sendJson({ feature_tags: 'true' })
  if (path === '/api/internal/tags') return sendJson(tags)
  if (path === '/api/internal/notes/home') return sendJson({ exists: true, body: noteBody, last_editor: 'Sample team', last_edited_at: capturedAt })
  if (path.endsWith('/notes/home/history')) return sendJson({ versions: [{ id: 3, editor: 'Sample team', edited_at: capturedAt, size_bytes: 620 }] })
  if (path.endsWith('/notes/home/history/3')) return sendJson({ id: 3, slug: 'home', body: noteBody, editor: 'Sample team', edited_at: capturedAt, size_bytes: 620 })
  if (path === '/api/internal/users') return sendJson({ users: [user, { ...user, id: 'sample-viewer', username: 'demo-viewer', displayName: 'Sample viewer', email: 'viewer@example.com', roles: ['viewer'], status: 'active' }].map(item => ({ ...item, status: 'active' })) })
  if (path === '/api/internal/service-accounts') return sendJson({ accounts: [{ id: 'sample-pipeline', name: 'audio-pipeline', description: '音声処理のOpenLineage送信', status: 'active' }] })
  if (path === '/api/internal/audit-events') return sendJson({ events: [], nextBeforeId: null })
  if (path === '/api/internal/lineage/catalog') return sendJson({ results: registryDatasets, totalCount: registryDatasets.length })
  if (path === '/api/internal/lineage/graph') return sendJson(lineageGraph)
  if (path.endsWith('/lineage/resolve-location')) return sendJson({ storageSystemKey: 'demo', uri: `s3://${SAMPLE_BUCKET}/${SAMPLE_PREFIX}`, matches: [] })
  if (path === '/api/internal/jobs/latest' || path === '/api/internal/jobs/1') return sendJson(scanJob)
  if (suffix === '/buckets') return sendJson({ buckets: ['audio-datasets', 'training-data', 'results', 'archive-2026', 'team-shared'].map(name => ({ name, creationDate: '2026-09-20T00:00:00Z' })), cache: { fetchedAt: capturedAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), hit: true } })
  if (suffix === '/favorites') return sendJson(['audio-datasets', 'team-shared'])
  if (suffix === '/tags') return sendJson(Object.fromEntries(url.searchParams.getAll('paths').map(name => [name, name.includes('audio') || name.endsWith('.wav') ? ['audio'] : ['ready']])))
  if (suffix === '/readme') return sendJson({ exists: true, body: readmeBody, last_editor: 'Sample team', last_edited_at: capturedAt, size_bytes: 620 })
  if (suffix === '/readme/history') return sendJson({ versions: [{ id: 3, editor: 'Sample team', edited_at: capturedAt, size_bytes: 620 }, { id: 2, editor: 'Sample team', edited_at: '2026-10-06T00:00:00Z', size_bytes: 410 }] })
  if (suffix.startsWith('/readme/history/')) return sendJson({ id: 3, bucket: SAMPLE_BUCKET, prefix: SAMPLE_PREFIX, body: readmeBody, editor: 'Sample team', edited_at: capturedAt, size_bytes: 620 })
  if (suffix === '/list') {
    const prefix = url.searchParams.get('prefix') ?? ''
    return sendJson({ directories: prefix ? ['samples/train/', 'samples/validation/'] : ['samples/', 'train/', 'validation/', 'test/'], files: prefix ? filenames.map(([name, size]) => ({ key: `${prefix}${name}`, size, lastModified: capturedAt })) : [], nextContinuation: null, nextStartAfter: null, cache: { fetchedAt: capturedAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), hit: false } })
  }
  if (suffix === '/preview/text' || (suffix === '/preview/tar-entry' && url.searchParams.get('entry')?.endsWith('.json'))) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'sample-001', filename: 'original.wav', sample_rate: 48000, channels: 1, duration_seconds: 12, language: 'ja', processing: { noise_reduction: true, version: '1.0' }, split: 'validation' }, null, 2) })
  if (suffix === '/preview/image' || suffix === '/media/spectrogram') return route.fulfill({ contentType: 'image/png', body: media.spectrogram })
  if (suffix === '/preview/audio') return route.fulfill({ contentType: 'audio/wav', body: media.audio })
  if (suffix === '/preview/video' || (suffix === '/preview/tar-entry' && url.searchParams.get('entry')?.endsWith('.mp4'))) return route.fulfill({ contentType: 'video/mp4', body: media.video })
  if (suffix === '/preview/tar') {
    const entries = Array.from({ length: 7 }, (_, index) => [
      { name: `sample-${String(index + 1).padStart(3, '0')}.mp4`, size: 1048576000, type: 'file' },
      { name: `sample-${String(index + 1).padStart(3, '0')}.json`, size: 2184, type: 'file' },
    ]).flat()
    return route.fulfill({ contentType: 'application/x-ndjson', body: [{ mode: 'range' }, ...entries.map(entry => ({ entry })), { done: { truncated: false, hasMore: false, offset: 0, limit: 200 } }].map(record => JSON.stringify(record)).join('\n') + '\n' })
  }
  if (suffix === '/media/analyze') return sendJson({ cacheKey: 'sample-waveform', peaks: media.peaks, durationSec: 12, sampleRate: 48000, hasSpectrogram: true, meta: { codec: 'pcm_s16le', container: 'wav', channels: 1, bitsPerSample: 16, bitRate: 768000, sizeBytes: media.audio.length, peakDb: -3.2, rmsDb: -18.4 } })
  if (suffix === '/capacity') return sendJson(capacityOverview(Number(url.searchParams.get('days') ?? 30)))
  if (suffix === '/capacity/prefix') return sendJson({ points: capacityOverview(30).buckets[0].points })
  if (suffix === '/scan') return sendJson({ jobId: 1 })
  if (suffix === '/estimate') return sendJson(transferEstimate())

  unhandled.push(`${route.request().method()} ${path}`)
  return route.fulfill({ status: 404, json: { error: 'この画面用のサンプル応答はありません' } })
}
