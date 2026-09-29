import { describe, expect, it } from 'vitest'
import type { LookupAddress } from 'node:dns'
import { isAllowedEndpoint, lookupAllowedAddress } from './endpoint-policy.js'

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
  function lookup(hostname: string, all: boolean) {
    return new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[] }>(resolve => {
      lookupAllowedAddress(hostname, { all }, (error, address) => resolve({ error, address }))
    })
  }

  it('名前解決の結果が loopback だけなら接続させない (DNS rebinding 対策)', async () => {
    const { error } = await lookup('localhost', false)
    expect(error?.code).toBe('EADDRNOTALLOWED')
  })

  it('all: true で呼ばれても、拒否するアドレスだけならエラーにする', async () => {
    const { error } = await lookup('localhost', true)
    expect(error?.code).toBe('EADDRNOTALLOWED')
  })
})
