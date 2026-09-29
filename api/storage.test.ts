import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { ListBucketsCommand } from '@aws-sdk/client-s3'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { CONNECTION_CACHE_TTL_MS, createStorageFactory } from './storage.js'
import { BlockedEndpointError, isBlockedAddress } from './lib/endpoint-policy.js'

// 接続先の名前解決だけを差し替える (pg など node_modules 側の名前解決には効かない)。
vi.mock('node:dns', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns')>()
  return { ...actual, lookup: vi.fn(actual.lookup) }
})

/** loopback は接続先として拒否するので、テスト用の S3 もどきはこのマシンの別のアドレスで待ち受ける。 */
function reachableTestHost(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    const usable = addresses?.find(address => address.family === 'IPv4' && !address.internal && !isBlockedAddress(address.address))
    if (usable) return usable.address
  }
  throw new Error('no non-loopback IPv4 address to run the local S3 stand-in on')
}

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const crypto = createCrypto('a'.repeat(64))

beforeEach(() => pools.rw.query('TRUNCATE storage_connections CASCADE'))
afterAll(() => closePools(pools))

async function insertConnection(id: string, endpoint = 'https://s3.example.com/'): Promise<void> {
  await pools.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style)
     VALUES ($1, $1, $4, 'auto', $2, $3, 'AKIA…0000', true)`,
    [id, crypto.encrypt('AKIAEXAMPLE12345'), crypto.encrypt('secret-value'), endpoint],
  )
}

describe('createStorageFactory の権限読み出し', () => {
  it('connection_settings に行が無ければ全許可', async () => {
    await insertConnection('conn000001')
    const f = createStorageFactory({ pools, crypto })
    try {
      const config = await f.getConnectionConfig('conn000001')
      expect(config.capabilities).toEqual({
        list: true, preview: true, download: true, archive: true,
        audioInfo: true, audioSpectrogram: true, readmeRead: true, readmeWrite: true,
      })
    } finally {
      await f.close()
    }
  })

  it("'false' の行だけが無効になる", async () => {
    await insertConnection('conn000002')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value)
       VALUES ('conn000002', 'cap.download', 'false'),
              ('conn000002', 'cap.readmeRead', 'true')`,
    )
    const f = createStorageFactory({ pools, crypto })
    try {
      const config = await f.getConnectionConfig('conn000002')
      expect(config.capabilities.download).toBe(false)
      expect(config.capabilities.readmeRead).toBe(true)
      expect(config.capabilities.archive).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('未知のキーが混ざっても壊れない', async () => {
    await insertConnection('conn000003')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value)
       VALUES ('conn000003', 'cap.somethingNew', 'false'),
              ('conn000003', 'unrelated.setting', 'x')`,
    )
    const f = createStorageFactory({ pools, crypto })
    try {
      const config = await f.getConnectionConfig('conn000003')
      expect(Object.values(config.capabilities).every(Boolean)).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('invalidate 後は権限を読み直す', async () => {
    await insertConnection('conn000004')
    const f = createStorageFactory({ pools, crypto })
    try {
      expect((await f.getConnectionConfig('conn000004')).capabilities.download).toBe(true)
      await pools.rw.query(
        `INSERT INTO connection_settings (connection_id, key, value)
         VALUES ('conn000004', 'cap.download', 'false')`,
      )
      // キャッシュを捨てるまでは古い値のまま (= キャッシュが効いている)。
      expect((await f.getConnectionConfig('conn000004')).capabilities.download).toBe(true)
      f.invalidate('conn000004')
      expect((await f.getConnectionConfig('conn000004')).capabilities.download).toBe(false)
    } finally {
      await f.close()
    }
  })
})

describe('接続ごとの走査可否とキャッシュ TTL', () => {
  it('設定が無ければ走査は許可、TTL は 24 時間', async () => {
    await insertConnection('conn000010')
    const f = createStorageFactory({ pools, crypto })
    try {
      const config = await f.getConnectionConfig('conn000010')
      expect(config.scanEnabled).toBe(true)
      expect(config.scanPageSize).toBe(1000)
      expect(config.capacityMetricsEnabled).toBe(true)
      expect(config.listCacheTtlSec).toBe(86400)
    } finally {
      await f.close()
    }
  })

  it('scan_page_sizeを許可値から読み、未知値は1000件へ戻す', async () => {
    await insertConnection('conn000015')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value) VALUES ($1, 'scan_page_size', '100')`,
      ['conn000015'],
    )
    await insertConnection('conn000016')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value) VALUES ($1, 'scan_page_size', '123')`,
      ['conn000016'],
    )
    const f = createStorageFactory({ pools, crypto })
    try {
      expect((await f.getConnectionConfig('conn000015')).scanPageSize).toBe(100)
      expect((await f.getConnectionConfig('conn000016')).scanPageSize).toBe(1000)
    } finally {
      await f.close()
    }
  })

  it("capacity_metrics_enabled='false' で容量メトリクス集計が無効になる", async () => {
    await insertConnection('conn000014')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value) VALUES ($1, 'capacity_metrics_enabled', 'false')`,
      ['conn000014'],
    )
    const f = createStorageFactory({ pools, crypto })
    try {
      expect((await f.getConnectionConfig('conn000014')).capacityMetricsEnabled).toBe(false)
    } finally {
      await f.close()
    }
  })

  it("scan_enabled='false' で走査が無効になる", async () => {
    await insertConnection('conn000011')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value) VALUES ($1, 'scan_enabled', 'false')`,
      ['conn000011'],
    )
    const f = createStorageFactory({ pools, crypto })
    try {
      expect((await f.getConnectionConfig('conn000011')).scanEnabled).toBe(false)
    } finally {
      await f.close()
    }
  })

  it('list_cache_ttl_sec が反映され、壊れた値は既定に倒す', async () => {
    await insertConnection('conn000012')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value) VALUES ($1, 'list_cache_ttl_sec', '300')`,
      ['conn000012'],
    )
    await insertConnection('conn000013')
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value) VALUES ($1, 'list_cache_ttl_sec', 'いいかんじ')`,
      ['conn000013'],
    )
    const f = createStorageFactory({ pools, crypto })
    try {
      expect((await f.getConnectionConfig('conn000012')).listCacheTtlSec).toBe(300)
      expect((await f.getConnectionConfig('conn000013')).listCacheTtlSec).toBe(86400)
    } finally {
      await f.close()
    }
  })
})

describe('S3Client のキャッシュ', () => {
  afterEach(() => vi.useRealTimers())

  it('同じ接続を同時に要求しても S3Client は 1 つだけ作る', async () => {
    await insertConnection('conn000020')
    const f = createStorageFactory({ pools, crypto })
    try {
      const [a, b] = await Promise.all([f.getStorage('conn000020'), f.getStorage('conn000020')])
      expect(a).toBe(b)
    } finally {
      await f.close()
    }
  })

  it('読み込み中に invalidate すると、その読み込みの結果はキャッシュに残らない', async () => {
    await insertConnection('conn000021')
    const f = createStorageFactory({ pools, crypto })
    try {
      const loadingBeforeInvalidate = f.getStorage('conn000021')
      f.invalidate('conn000021')
      const stale = await loadingBeforeInvalidate
      expect(await f.getStorage('conn000021')).not.toBe(stale)
    } finally {
      await f.close()
    }
  })

  it('期限を過ぎると接続設定を読み直す (invalidate を受け取れない worker でも変更を拾う)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await insertConnection('conn000022')
    const f = createStorageFactory({ pools, crypto })
    try {
      expect((await f.getConnectionConfig('conn000022')).scanPageSize).toBe(1000)
      await pools.rw.query(
        `INSERT INTO connection_settings (connection_id, key, value) VALUES ('conn000022', 'scan_page_size', '100')`,
      )
      vi.advanceTimersByTime(CONNECTION_CACHE_TTL_MS - 1)
      expect((await f.getConnectionConfig('conn000022')).scanPageSize).toBe(1000)
      vi.advanceTimersByTime(1)
      expect((await f.getConnectionConfig('conn000022')).scanPageSize).toBe(100)
    } finally {
      await f.close()
    }
  })

  describe('別の接続を invalidate しても', () => {
    const LIST_BUCKETS_XML =
      '<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>'
    const replyListBuckets = (res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(LIST_BUCKETS_XML)
    }
    let fastServer: Server
    let slowServer: Server
    let heldResponse: Promise<ServerResponse>

    beforeEach(async () => {
      fastServer = createServer((_req, res) => replyListBuckets(res))
      let holdResponse: (res: ServerResponse) => void = () => {}
      heldResponse = new Promise(resolve => { holdResponse = resolve })
      slowServer = createServer((_req, res) => holdResponse(res))
      await Promise.all([fastServer, slowServer].map(server =>
        new Promise<void>(resolve => server.listen(0, reachableTestHost(), resolve))))
    })
    afterEach(async () => {
      await Promise.all([fastServer, slowServer].map(server => {
        server.closeAllConnections()
        return new Promise<void>(resolve => server.close(() => resolve()))
      }))
    })

    it('実行中の S3 リクエストは切れない', async () => {
      const endpointOf = (server: Server) => {
        const { address, port } = server.address() as AddressInfo
        return `http://${address}:${port}/`
      }
      await insertConnection('conn000023', endpointOf(slowServer))
      await insertConnection('conn000024', endpointOf(fastServer))
      const f = createStorageFactory({ pools, crypto })
      try {
        // invalidate する側の client にも一度通信させ、共有 agent を握らせておく。
        await (await f.getStorage('conn000024')).send(new ListBucketsCommand({}))
        const inFlight = (await f.getStorage('conn000023')).send(new ListBucketsCommand({}))
        const response = await heldResponse

        f.invalidate('conn000024')
        replyListBuckets(response)
        await expect(inFlight).resolves.toMatchObject({ Buckets: [] })
      } finally {
        await f.close()
      }
    })
  })
})

describe('S3 の接続先の検査', () => {
  it('DNS 名が loopback を指すエンドポイントには接続しない (DNS rebinding 対策)', async () => {
    // 保存時は普通の DNS 名だったものが、あとから loopback を指すようになった場合。
    vi.mocked(dnsLookup).mockImplementationOnce(((_hostname: string, _options: unknown, callback: (
      error: NodeJS.ErrnoException | null, addresses: LookupAddress[],
    ) => void) => callback(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as typeof dnsLookup)
    await insertConnection('conn000030', 'http://rebind.example:9/')
    const f = createStorageFactory({ pools, crypto })
    try {
      const request = (await f.getStorage('conn000030')).send(new ListBucketsCommand({}))
      await expect(request).rejects.toMatchObject({ code: 'EADDRNOTALLOWED' })
    } finally {
      await f.close()
    }
  })

  it('検査を強める前に保存された、拒否するアドレスの接続先は使わない', async () => {
    await insertConnection('conn000031', 'http://[::ffff:127.0.0.1]:9000/')
    const f = createStorageFactory({ pools, crypto })
    try {
      await expect(f.getStorage('conn000031')).rejects.toBeInstanceOf(BlockedEndpointError)
    } finally {
      await f.close()
    }
  })
})
