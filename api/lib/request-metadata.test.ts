import { describe, expect, it } from 'vitest'
import { requestMetadata } from './request-metadata.js'

function context(headers: Record<string, string>) {
  return { req: { header: (name: string) => headers[name.toLowerCase()] } }
}

describe('requestMetadata', () => {
  it('正規化済みIPとUUIDだけを受理する', () => {
    expect(requestMetadata(context({
      'x-forwarded-for': '192.0.2.10',
      'x-request-id': '8f4f72c5-3e53-4ed7-a965-bd24f4fe5eb8',
      'user-agent': 'browser',
    }))).toEqual({
      ipAddress: '192.0.2.10',
      requestId: '8f4f72c5-3e53-4ed7-a965-bd24f4fe5eb8',
      userAgent: 'browser',
    })
  })

  it('偽装chainとDB型を壊す値を破棄する', () => {
    expect(requestMetadata(context({
      'x-forwarded-for': 'garbage, 192.0.2.10',
      'x-request-id': 'not-a-uuid',
    }))).toMatchObject({ ipAddress: null, requestId: null })
  })

  it('nginxの32桁request IDをUUID表記へ正規化する', () => {
    expect(requestMetadata(context({
      'x-request-id': '8f4f72c53e534ed7a965bd24f4fe5eb8',
    })).requestId).toBe('8f4f72c5-3e53-4ed7-a965-bd24f4fe5eb8')
  })
})
