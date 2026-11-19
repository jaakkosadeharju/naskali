import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyChanges } from '../session'
import { resultEditInfo } from '../resultEditing'
import type { Driver } from '../drivers/types'
import type { QueryResult, ResultField } from '../../shared/types'

/** How a dialect spells the shared integration queries against the seeded `shop` data. */
export interface SuiteSql {
  /** Schema the seeded tables live in (MySQL: shop, PostgreSQL: public, SQL Server: dbo). */
  schema: string
  /** Quotes an identifier. */
  q: (name: string) => string
}

const rows = (r: QueryResult): Extract<QueryResult, { kind: 'rows' }> => {
  if (r.kind !== 'rows') throw new Error('Expected rows')
  return r
}
const sources = (fields: ResultField[]) => fields.map((f) => (f.source ? `${f.source.table}.${f.source.column}` : null))

/** Column-origin and query-result editing tests shared by the server drivers. */
export function driverSuite(name: string, create: () => Driver, { schema, q }: SuiteSql): void {
  describe(name, () => {
    let driver: Driver
    beforeAll(async () => {
      driver = create()
      await driver.connect()
    })
    afterAll(() => driver?.disconnect())

    const select = async (sql: string) => rows(await driver.query(sql))
    const nameOf = async (table: string, id: number): Promise<unknown> =>
      (await select(`SELECT name FROM ${table} WHERE id = ${id}`)).rows[0]?.[0]

    it('keeps editor writes on the session controlled by commit and rollback', async () => {
      const mssql = driver.dialect.kind === 'mssql'
      const table = `naskali_editor_tx_${process.pid}`
      await driver.query(`CREATE ${mssql ? '' : 'TEMPORARY '}TABLE ${table} (id INT)`)
      try {
        await driver.beginEditorTransaction()
        expect(await driver.editorTransactionStatus()).toBe('active')
        await driver.query(`INSERT INTO ${table} VALUES (1)`)
        expect((await select(`SELECT id FROM ${table}`)).rows).toEqual([[1]])
        await driver.endEditorTransaction('rollback')
        expect(await driver.editorTransactionStatus()).toBe('idle')
        expect((await select(`SELECT id FROM ${table}`)).rows).toEqual([])

        await driver.beginEditorTransaction()
        await driver.query(`INSERT INTO ${table} VALUES (2)`)
        await driver.endEditorTransaction('commit')
        expect(await driver.editorTransactionStatus()).toBe('idle')
        expect((await select(`SELECT id FROM ${table}`)).rows).toEqual([[2]])

        if (driver.dialect.kind === 'postgres') {
          await driver.beginEditorTransaction()
          await expect(driver.query('SELECT no_such_column')).rejects.toThrow()
          expect(await driver.editorTransactionStatus()).toBe('failed')
          await driver.endEditorTransaction('rollback')
        }
      } finally {
        if (await driver.editorTransactionStatus() !== 'idle') await driver.endEditorTransaction('rollback')
        await driver.query(`DROP TABLE ${table}`)
      }
    })

    it('reports the table column of every selected column', async () => {
      const r = await select('SELECT * FROM customers WHERE id = 1')
      expect(r.fields.every((f) => f.source?.schema === schema && f.source.table === 'customers')).toBe(true)
      expect(r.fields.map((f) => f.source?.column)).toEqual(r.fields.map((f) => f.name))
    })

    it('reports the real column behind an alias', async () => {
      const r = await select(`SELECT name AS ${q('n')}, id AS ${q('k')} FROM customers WHERE id = 1`)
      expect(sources(r.fields)).toEqual(['customers.name', 'customers.id'])
    })

    it('reports each column of a join', async () => {
      const r = await select('SELECT o.id, o.quantity, c.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 1')
      expect(sources(r.fields)).toEqual(['orders.id', 'orders.quantity', 'customers.id', 'customers.name'])
    })

    it('reports no table column for expressions', async () => {
      const r = await select(`SELECT UPPER(name) AS ${q('u')}, id + 1 AS ${q('n')} FROM customers WHERE id = 1`)
      expect(sources(r.fields)).toEqual([null, null])
    })

    it('finds the editable tables of a join', async () => {
      const sql = 'SELECT o.id, o.quantity, c.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 1'
      const info = await resultEditInfo(driver, sql, (await select(sql)).fields)
      expect(info.tables.map((t) => [t.table, t.key.map((k) => k.field), t.columns.map((c) => c.column)])).toEqual([
        ['orders', [0], ['id', 'quantity']],
        ['customers', [2], ['id', 'name']]
      ])
    })

    it('keeps a table joined to itself read-only', async () => {
      const sql = 'SELECT a.id, a.name, b.email FROM customers a JOIN customers b ON b.id = a.id + 1'
      const fields = (await select(sql)).fields
      expect(sources(fields)).toEqual(['customers.id', 'customers.name', 'customers.email'])
      expect((await resultEditInfo(driver, sql, fields)).tables).toEqual([])
    })

    it('keeps a UNION read-only', async () => {
      const sql = 'SELECT id, name FROM customers UNION ALL SELECT id, name FROM products'
      expect((await resultEditInfo(driver, sql, (await select(sql)).fields)).tables).toEqual([])
    })

    it('saves edits to two tables in one transaction', async () => {
      const before = [await nameOf('customers', 2), await nameOf('products', 2)]
      try {
        const summary = await applyChanges(driver, [
          { schema, table: 'customers', deletes: [], inserts: [], updates: [{ key: { id: 2 }, set: { name: 'Edited customer' } }] },
          { schema, table: 'products', deletes: [], inserts: [], updates: [{ key: { id: 2 }, set: { name: 'Edited product' } }] }
        ])
        expect(summary).toEqual({ deleted: 0, updated: 2, inserted: 0 })
        expect([await nameOf('customers', 2), await nameOf('products', 2)]).toEqual(['Edited customer', 'Edited product'])
      } finally {
        await applyChanges(driver, [
          { schema, table: 'customers', deletes: [], inserts: [], updates: [{ key: { id: 2 }, set: { name: before[0] as string } }] },
          { schema, table: 'products', deletes: [], inserts: [], updates: [{ key: { id: 2 }, set: { name: before[1] as string } }] }
        ])
      }
    })

    it('rolls back every table when one row is missing', async () => {
      const before = await nameOf('customers', 3)
      await expect(
        applyChanges(driver, [
          { schema, table: 'customers', deletes: [], inserts: [], updates: [{ key: { id: 3 }, set: { name: 'Should not stay' } }] },
          { schema, table: 'products', deletes: [], inserts: [], updates: [{ key: { id: -1 }, set: { name: 'Missing' } }] }
        ])
      ).rejects.toThrow(/Nothing was saved/)
      expect(await nameOf('customers', 3)).toBe(before)
    })
  })
}
