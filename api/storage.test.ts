import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { createStorageFactory } from './storage.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const crypto = createCrypto('a'.repeat(64))

beforeEach(() => pools.rw.query('TRUNCATE storage_connections CASCADE'))
afterAll(() => closePools(pools))

async function insertConnection(id: string): Promise<void> {
  await pools.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked)
     VALUES ($1, $1, 'https://s3.example.com/', 'auto', $2, $3, 'AKIA…0000')`,
    [id, crypto.encrypt('AKIAEXAMPLE12345'), crypto.encrypt('secret-value')],
  )
}

describe('createStorageFactory の権限読み出し', () => {
  it('connection_settings に行が無ければ全許可', async () => {
    await insertConnection('conn000001')
    const f = createStorageFactory({ pools, crypto })
    try {
      const cfg = await f.getConnectionConfig('conn000001')
      expect(cfg.capabilities).toEqual({
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
      const cfg = await f.getConnectionConfig('conn000002')
      expect(cfg.capabilities.download).toBe(false)
      expect(cfg.capabilities.readmeRead).toBe(true)
      expect(cfg.capabilities.archive).toBe(true)
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
      const cfg = await f.getConnectionConfig('conn000003')
      expect(Object.values(cfg.capabilities).every(Boolean)).toBe(true)
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
      const cfg = await f.getConnectionConfig('conn000010')
      expect(cfg.scanEnabled).toBe(true)
      expect(cfg.listCacheTtlSec).toBe(86400)
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
