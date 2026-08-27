import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter } from './audit.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const audit = createAuditWriter(pools.rw)

beforeEach(() => pools.rw.query('TRUNCATE audit_events CASCADE'))
afterAll(() => closePools(pools))

describe('AuditWriter intent', () => {
  it('pending intentを完了しdetailsを安全に追記する', async () => {
    const id = await audit.start({
      actor: { type: 'anonymous' },
      action: 'test.mutation',
      resourceType: 'test',
      resourceId: 'resource-1',
      details: { phase: 'before' },
    })
    const pending = await pools.rw.query(
      'SELECT outcome, details FROM audit_events WHERE id = $1', [id],
    )
    expect(pending.rows[0]).toMatchObject({ outcome: 'pending', details: { phase: 'before' } })

    await audit.finish(id, 'success', { phase: 'after', token: 'must-not-remain' })
    const finished = await pools.rw.query(
      'SELECT outcome, details FROM audit_events WHERE id = $1', [id],
    )
    expect(finished.rows[0]).toMatchObject({
      outcome: 'success',
      details: { phase: 'after', token: '[REDACTED]' },
    })
  })

  it('route固有の監査へ置き換える場合はpending intentだけを破棄する', async () => {
    const id = await audit.start({ actor: { type: 'system' }, action: 'test.replace' })
    await audit.discard(id)
    const result = await pools.rw.query('SELECT id FROM audit_events WHERE id = $1', [id])
    expect(result.rowCount).toBe(0)
  })
})
