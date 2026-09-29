import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isAllowedEndpoint, lookupAllowedAddress } from './endpoint-policy.js'

vi.mock('node:dns', () => ({ lookup: vi.fn() }))

describe('isAllowedEndpoint', () => {
  it.each([
    ['cloud metadata',               'http://169.254.169.254/latest/meta-data/'],
    ['IPv4 loopback',                'http://127.0.0.1/'],
    ['10 進表記の IPv4 loopback',     'http://2130706433/'],
    ['localhost',                    'http://localhost:9000/'],
    ['末尾ドット付きの localhost',     'http://localhost./'],
    ['localhost のサブドメイン',       'http://minio.localhost/'],
    ['unspecified IPv4',             'http://0.0.0.0/'],
    ['IPv6 loopback',                'http://[::1]:9000/'],
    ['IPv6 link-local',              'http://[fe80::1]:9000/'],
    ['IPv4-mapped IPv6 の loopback', 'http://[::ffff:127.0.0.1]:9000/'],
    ['IPv4-mapped IPv6 の metadata', 'http://[::ffff:169.254.169.254]/'],
    ['IPv4-compatible IPv6',         'http://[::7f00:1]/'],
    ['AWS の IPv6 metadata',          'http://[fd00:ec2::254]/'],
  ])('%s へ向くエンドポイントは拒否する', (_label, endpoint) => {
    expect(isAllowedEndpoint(endpoint)).toBe(false)
  })

  it.each([
    ['AWS S3',          'https://s3.ap-northeast-1.amazonaws.com/'],
    ['LAN の MinIO',     'http://192.168.10.20:9000/'],
    ['RFC1918 の 10/8',  'https://10.15.20.150/'],
    ['IPv6 ULA',        'http://[fd12:3456::1]:9000/'],
  ])('%s へ向くエンドポイントは許可する', (_label, endpoint) => {
    expect(isAllowedEndpoint(endpoint)).toBe(true)
  })

  it('URL でなければ拒否する', () => {
    expect(isAllowedEndpoint('not-a-url')).toBe(false)
  })
})

describe('lookupAllowedAddress', () => {
  /** 名前解決の結果を addresses に差し替える。 */
  function resolvesTo(addresses: LookupAddress[]) {
    vi.mocked(dnsLookup).mockImplementation(((_hostname: string, _options: unknown, callback: (
      error: NodeJS.ErrnoException | null, addresses: LookupAddress[],
    ) => void) => callback(null, addresses)) as unknown as typeof dnsLookup)
  }
  function lookup(hostname: string, all: boolean) {
    return new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>(resolve => {
      lookupAllowedAddress(hostname, { all }, (error, address, family) => resolve({ error, address, family }))
    })
  }
  // 値を返すと vitest が後片付けの関数として呼ぶので、ブロックで書く。
  beforeEach(() => { vi.mocked(dnsLookup).mockReset() })

  it('名前解決の結果が loopback だけなら接続させない (DNS rebinding 対策)', async () => {
    resolvesTo([{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])
    expect((await lookup('rebind.example', false)).error?.code).toBe('EADDRNOTALLOWED')
    expect((await lookup('rebind.example', true)).error?.code).toBe('EADDRNOTALLOWED')
  })

  it('許可するアドレスと混ざっていたら、許可するものだけを返す', async () => {
    resolvesTo([
      { address: '127.0.0.1', family: 4 },
      { address: '::ffff:127.0.0.1', family: 6 },
      { address: '192.0.2.10', family: 4 },
    ])
    expect(await lookup('mixed.example', false)).toEqual({ error: null, address: '192.0.2.10', family: 4 })
    expect(await lookup('mixed.example', true)).toEqual({
      error: null, address: [{ address: '192.0.2.10', family: 4 }], family: undefined,
    })
  })

  it('名前解決そのものの失敗は、そのまま返す', async () => {
    vi.mocked(dnsLookup).mockImplementation(((_hostname: string, _options: unknown, callback: (
      error: NodeJS.ErrnoException | null,
    ) => void) => callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }))) as unknown as typeof dnsLookup)
    expect((await lookup('missing.example', false)).error?.code).toBe('ENOTFOUND')
  })
})
