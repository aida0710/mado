import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools, withTransaction } from './db.js'

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
  it('rw は INSERT でき、ro は SELECT できる', async () => {
    await pools.rw.query(
      `INSERT INTO notes(slug, body, last_editor) VALUES ($1, $2, $3)`,
      ['db-test', 'hello', 'tester']
    )
    const r = await pools.ro.query(
      'SELECT slug, body FROM notes ORDER BY slug'
    )
    expect(r.rows).toEqual([{ slug: 'db-test', body: 'hello' }])
  })

  it('ro は INSERT できない', async () => {
    await expect(
      pools.ro.query(
        `INSERT INTO notes(slug, body) VALUES ('x','y')`
      )
    ).rejects.toThrow(/permission denied/i)
  })

  it('ro は CREATE TABLE できない', async () => {
    await expect(
      pools.ro.query('CREATE TABLE t (id int)')
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('withTransaction', () => {
  it('最後まで進めば commit する', async () => {
    await withTransaction(pools.rw, client =>
      client.query(`INSERT INTO notes(slug, body, last_editor) VALUES ('tx-commit', 'a', 't')`))
    const r = await pools.ro.query(`SELECT slug FROM notes WHERE slug = 'tx-commit'`)
    expect(r.rows).toHaveLength(1)
  })

  it('途中で投げたら rollback し、元の例外を投げ直す', async () => {
    await expect(withTransaction(pools.rw, async client => {
      await client.query(`INSERT INTO notes(slug, body, last_editor) VALUES ('tx-rollback', 'a', 't')`)
      throw new Error('途中で失敗')
    })).rejects.toThrow('途中で失敗')
    const r = await pools.ro.query(`SELECT slug FROM notes WHERE slug = 'tx-rollback'`)
    expect(r.rows).toHaveLength(0)
  })
})
