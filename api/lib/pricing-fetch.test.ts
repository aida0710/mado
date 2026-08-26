import { describe, expect, it, vi } from 'vitest'
import { fetchCatalog, FETCH_REGIONS } from './pricing-fetch.js'

// 実際の AWS は叩かない。ここで守りたいのは「取り違えたときに黙って 0 に
// ならない」ことなので、最小限のダミー応答で分岐を突く。

const TOKYO = 'Asia Pacific (Tokyo)'
const VIRGINIA = 'US East (N. Virginia)'

/** meteredUnitMap の 1 リージョンぶん。必要な行を全部持つ。 */
function meteredRows(overrides: Record<string, string> = {}): Record<string, { price: string }> {
  const rows: Record<string, string> = {
    'Standard Storage First 50 TB per GB Mo': '0.025',
    'Standard Storage Next 450 TB per GB Mo': '0.024',
    'Standard Storage Over 500 TB per GB Mo': '0.023',
    'PUT COPY/POST or LIST requests per Requests': '0.0000047',
    'GET and all other requests per Requests': '0.00000037',
    'Intelligent Tiering Frequent Access First 50 TB per GB Mo': '0.025',
    'Intelligent Tiering Frequent Access Next 450 TB per GB Mo': '0.024',
    'Intelligent Tiering Frequent Access Over 500 TB per GB Mo': '0.023',
    'PUT COPY/POST or LIST requests to Intelligent Tiering per Requests': '0.0000047',
    'GET and all other requests to Intelligent Tiering per Requests': '0.00000037',
    'Per object per month monitoring and automation fee for objects in Intelligent Tiering': '0.0000025',
    'Standard Infrequent Access Storage per GB-Mo': '0.0138',
    'PUT COPY/POST or LIST requests to Standard Infrequent Access per Requests': '0.00001',
    'GET and all other requests to Standard Infrequent Access per Requests': '0.000001',
    'Object Retrieval in Standard Infrequent Access per GB': '0.01',
    'One Zone Infrequent Access Storage Inf per GB-Mo': '0.011',
    'PUT COPY/POST or LIST requests to One Zone Infrequent Access per Requests': '0.00001',
    'GET and all other requests to One Zone Infrequent Access per Requests': '0.000001',
    'Object Retrieval in One Zone Infrequent Access per GB': '0.01',
    'Glacier Instant Retrieval Storage': '0.005',
    'PUT COPY/POST or LIST requests to Glacier Instant Retrieval per Requests': '0.00002',
    'GET and all other requests to Glacier Instant Retrieval per Requests': '0.00001',
    'Object Retrieval in Glacier Instant Retrieval per GB': '0.03',
    'Glacier Storage per GB Mo': '0.0045',
    'PUT requests to Glacier per Requests': '0.00003426',
    'GET and all other requests to GLACIER per Requests': '0.00000037',
    'Fee for Standard Retrieval of data stored': '0.011',
    'IntelligentTieringDeepArchiveAccess': '0.002',
    'Lifecycle Transition Requests into Glacier Deep Archive per Requests': '0.000065',
    'GET and all other requests to GDA per Requests': '0.00000037',
    'Fee for Standard Retrieval of data stored from Glacier Deep Archive': '0.022',
    ...overrides,
  }
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { price: v }]))
}

interface DtTier { begin: string; end: string; usd: string }

/** AWSDataTransfer のリージョン別 index。usagetype ごとに段を持つ。 */
function dtDoc(entries: Array<{ usagetype: string; tiers: DtTier[] }>): unknown {
  const products: Record<string, unknown> = {}
  const onDemand: Record<string, unknown> = {}
  entries.forEach((e, i) => {
    const sku = `SKU${i}`
    products[sku] = {
      attributes: {
        usagetype: e.usagetype,
        transferType: 'AWS Outbound',
        toLocation: 'External',
      },
    }
    onDemand[sku] = {
      term: {
        priceDimensions: Object.fromEntries(e.tiers.map((t, j) => [`d${j}`, {
          beginRange: t.begin, endRange: t.end, pricePerUnit: { USD: t.usd },
        }])),
      },
    }
  })
  return { products, terms: { OnDemand: onDemand } }
}

const DEFAULT_DT = dtDoc([
  // 無料枠。これを単価表と取り違えると egress が丸ごと 0 になる。
  { usagetype: 'Global-DataTransfer-Out-Bytes', tiers: [{ begin: '0', end: '100', usd: '0' }] },
  {
    usagetype: 'APN1-DataTransfer-Out-Bytes',
    tiers: [
      { begin: '0', end: '10240', usd: '0.114' },
      { begin: '10240', end: 'Inf', usd: '0.089' },
    ],
  },
])

interface FakeOptions {
  metered?: unknown
  dt?: unknown
}

/** URL で応答を出し分ける fetch。 */
function fakeFetch(opts: FakeOptions = {}): typeof fetch {
  const metered = opts.metered ?? {
    manifest: { hawkFilePublicationDate: '2026-08-18T18:11:13Z' },
    regions: { [TOKYO]: meteredRows(), [VIRGINIA]: meteredRows() },
  }
  const dt = opts.dt ?? DEFAULT_DT

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('meteredUnitMaps') ? metered
      : url.includes('region_index.json')
        ? {
            regions: Object.fromEntries(FETCH_REGIONS.map(r =>
              [r.code, { currentVersionUrl: `/offers/${r.code}/index.json` }])),
          }
        : dt
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

const NOW = (): Date => new Date('2026-08-22T00:00:00Z')

describe('fetchCatalog', () => {
  it('全ストレージクラスと egress を組み立てる', async () => {
    const catalog = await fetchCatalog({ fetchImpl: fakeFetch(), now: NOW })

    expect(catalog.asOf).toBe('2026-08-22')
    expect(catalog.awsPublishedAt).toBe('2026-08-18T18:11:13Z')
    expect(Object.keys(catalog.aws.regions)).toEqual(FETCH_REGIONS.map(r => r.code))

    const tokyo = catalog.aws.regions['ap-northeast-1']
    expect(tokyo.storageClasses.STANDARD.storageTiers).toEqual([
      { upToGb: 51200, usd: 0.025 },
      { upToGb: 512000, usd: 0.024 },
      { upToGb: null, usd: 0.023 },
    ])
    expect(tokyo.storageClasses.DEEP_ARCHIVE.storageRateSource).toBe('proxy')
    expect(tokyo.storageClasses.STANDARD.storageRateSource).toBe('api')
  })

  it('リクエスト単価を $/1000 に直す (浮動小数のゴミを残さない)', async () => {
    const catalog = await fetchCatalog({ fetchImpl: fakeFetch(), now: NOW })
    const std = catalog.aws.regions['ap-northeast-1'].storageClasses.STANDARD
    expect(std.putPer1000).toBe(0.0047)
    expect(std.getPer1000).toBe(0.00037)
    // 0.000065 × 1000 が 0.06499999999999999 にならないこと。
    expect(catalog.aws.regions['ap-northeast-1'].storageClasses.DEEP_ARCHIVE.putPer1000).toBe(0.065)
  })

  it('egress は Global (無料枠) ではなくリージョンの段を採る', async () => {
    const catalog = await fetchCatalog({ fetchImpl: fakeFetch(), now: NOW })
    const tokyo = catalog.aws.regions['ap-northeast-1']
    expect(tokyo.egressTiers).toEqual([
      { fromGb: 0, upToGb: 10240, usd: 0.114 },
      { fromGb: 10240, upToGb: null, usd: 0.089 },
    ])
    expect(tokyo.egressFreeGb).toBe(100)
  })

  it('プレフィックスの無い usagetype (us-east-1 の形) も拾う', async () => {
    const dt = dtDoc([
      { usagetype: 'Global-DataTransfer-Out-Bytes', tiers: [{ begin: '0', end: '100', usd: '0' }] },
      { usagetype: 'DataTransfer-Out-Bytes', tiers: [{ begin: '0', end: 'Inf', usd: '0.09' }] },
    ])
    const catalog = await fetchCatalog({ fetchImpl: fakeFetch({ dt }), now: NOW })
    expect(catalog.aws.regions['us-east-1'].egressTiers[0].usd).toBe(0.09)
  })

  it('egress が全て 0 なら落とす (取り違えを静かに通さない)', async () => {
    // Global (無料枠) しか無い = リージョンの単価表を引けていない状態。
    const dt = dtDoc([
      { usagetype: 'Global-DataTransfer-Out-Bytes', tiers: [{ begin: '0', end: '100', usd: '0' }] },
      { usagetype: 'APN1-DataTransfer-Out-Bytes', tiers: [{ begin: '0', end: 'Inf', usd: '0' }] },
    ])
    await expect(fetchCatalog({ fetchImpl: fakeFetch({ dt }), now: NOW }))
      .rejects.toThrow(/単価が全て 0/)
  })

  it('egress の usagetype が無ければ落とす', async () => {
    const dt = dtDoc([
      { usagetype: 'Global-DataTransfer-Out-Bytes', tiers: [{ begin: '0', end: '100', usd: '0' }] },
    ])
    await expect(fetchCatalog({ fetchImpl: fakeFetch({ dt }), now: NOW }))
      .rejects.toThrow(/usagetype が見つかりません/)
  })

  it('料金の行が消えていたら落とす (静かに 0 にしない)', async () => {
    const rows = meteredRows()
    delete rows['Glacier Storage per GB Mo']
    const metered = { regions: { [TOKYO]: rows, [VIRGINIA]: meteredRows() } }
    await expect(fetchCatalog({ fetchImpl: fakeFetch({ metered }), now: NOW }))
      .rejects.toThrow(/料金の行が見つかりません/)
  })

  it('リージョンが料金表に無ければ落とす', async () => {
    const metered = { regions: { [VIRGINIA]: meteredRows() } }
    await expect(fetchCatalog({ fetchImpl: fakeFetch({ metered }), now: NOW }))
      .rejects.toThrow(/リージョンがありません/)
  })

  it('HTTP エラーは伝える', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await expect(fetchCatalog({ fetchImpl: failing, now: NOW })).rejects.toThrow(/503/)
  })

  it('キャンセルされたら中断する', async () => {
    const ac = new AbortController()
    ac.abort()
    const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error('aborted')
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await expect(fetchCatalog({ fetchImpl: impl, signal: ac.signal, now: NOW }))
      .rejects.toThrow()
  })

  it('進捗を通知する', async () => {
    const seen: string[] = []
    await fetchCatalog({ fetchImpl: fakeFetch(), now: NOW, onProgress: m => seen.push(m) })
    expect(seen[0]).toContain('料金表')
    expect(seen).toContain('ap-northeast-1 の単価を取得中')
  })

  it('Wasabi の定額を載せる', async () => {
    const catalog = await fetchCatalog({ fetchImpl: fakeFetch(), now: NOW })
    expect(catalog.wasabi.perTbMonthUsd).toBeGreaterThan(0)
    expect(catalog.wasabi.minDurationDays).toBe(90)
  })
})
