import { describe, expect, it } from 'vitest'
import { redactAuditDetails } from './audit.js'

describe('redactAuditDetails', () => {
  it('秘密になり得るkeyをネストまでredactする', () => {
    expect(redactAuditDetails({
      token: 'x',
      safe: 'ok',
      nested: { passwordHash: 'y', values: [{ authorization: 'z' }] },
    })).toEqual({
      token: '[REDACTED]',
      safe: 'ok',
      nested: { passwordHash: '[REDACTED]', values: [{ authorization: '[REDACTED]' }] },
    })
  })
})
