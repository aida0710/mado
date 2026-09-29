import { lookup as dnsLookup } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'

// 接続先の S3 エンドポイントとして使わせないアドレス (SSRF 緩和)。
// cloud metadata や同一ホスト内のサービスへの到達経路を断つ。RFC1918 と IPv6 ULA は
// LAN 内の MinIO など正当な使い方があるので許可する。
// BlockList は IPv4-mapped IPv6 (::ffff:127.0.0.1 など) も IPv4 の範囲として判定する。
const BLOCKED_ADDRESSES = new BlockList()
BLOCKED_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4')        // this network (0.0.0.0 は自ホスト扱い)
BLOCKED_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')      // loopback
BLOCKED_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4')   // link-local (cloud metadata を含む)
BLOCKED_ADDRESSES.addSubnet('::', 96, 'ipv6')            // unspecified・loopback・IPv4-compatible
BLOCKED_ADDRESSES.addSubnet('fe80::', 10, 'ipv6')        // link-local
BLOCKED_ADDRESSES.addAddress('fd00:ec2::254', 'ipv6')    // AWS の IPv6 metadata (ULA の中にある)

/** 保存されている接続先が、検査で拒否するアドレスを指している。検査を強める前に保存された接続で起きる。 */
export class BlockedEndpointError extends Error {
  constructor(readonly connectionId: string) {
    super(`endpoint of connection ${connectionId} points to a blocked address`)
    this.name = 'BlockedEndpointError'
  }
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return BLOCKED_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** 接続の保存時に使う検査。DNS 名は名前解決の時点で lookupAllowedAddress が検査する。 */
export function isAllowedEndpoint(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  // 末尾ドット付きの FQDN (localhost.) も同じ名前として扱う。
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()
  if (host === '') return false
  if (isIP(host) !== 0) return !isBlockedAddress(host)
  return host !== 'localhost' && !host.endsWith('.localhost')
}

/**
 * S3 への接続で使う名前解決。保存時の検査だけでは、DNS 名が後から loopback や
 * metadata を指すように変わる (DNS rebinding) と防げないので、接続のたびに検査する。
 * IP を直接書いたエンドポイントは Node がこの関数を呼ばないので、保存時の検査に任せる。
 */
export const lookupAllowedAddress: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '')
    const allowed = addresses.filter(entry => !isBlockedAddress(entry.address))
    if (allowed.length === 0) {
      const blocked: NodeJS.ErrnoException = new Error(`${hostname} resolves only to blocked addresses`)
      blocked.code = 'EADDRNOTALLOWED'
      return callback(blocked, '')
    }
    if (options.all) return callback(null, allowed)
    callback(null, allowed[0].address, allowed[0].family)
  })
}
