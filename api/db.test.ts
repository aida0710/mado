import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from './db.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')

const pools = createPools({ rw: RW, ro: RO })

beforeEach(async () => {
  await pools.rw.query('TRUNCATE notes')
  await pools.rw.query('TRUNCATE storage_readme_meta')
})
afterAll(() => closePools(pools))

describe('createPools', () => {
  it('rw can insert, ro can select', async () => {
    await pools.rw.query(
      `INSERT INTO notes(slug, body, last_editor) VALUES ($1, $2, $3)`,
      ['db-test', 'hello', 'tester']
    )
    const r = await pools.ro.query(
      'SELECT slug, body FROM notes ORDER BY slug'
    )
    expect(r.rows).toEqual([{ slug: 'db-test', body: 'hello' }])
  })

  it('ro cannot insert', async () => {
    await expect(
      pools.ro.query(
        `INSERT INTO notes(slug, body) VALUES ('x','y')`
      )
    ).rejects.toThrow(/permission denied/i)
  })

  it('ro cannot create tables', async () => {
    await expect(
      pools.ro.query('CREATE TABLE t (id int)')
    ).rejects.toThrow(/permission denied/i)
  })
})
