import { describe, expect, it } from 'vitest'
import { resultEditInfo } from './resultEditing'
import { fakeDriver, table } from './testing/fakeDriver'
import type { ResultField } from '../shared/types'

const customers = table('shop', 'customers', [
  { name: 'id', key: 'PRI', nullable: false },
  { name: 'name', type: 'varchar(100)', nullable: false },
  { name: 'email', type: 'varchar(200)' }
])
const orders = table('shop', 'orders', [
  { name: 'id', key: 'PRI', nullable: false },
  { name: 'customer_id', nullable: false },
  { name: 'status', type: 'varchar(20)' },
  { name: 'total_cents', extra: 'STORED GENERATED' },
  { name: 'receipt', type: 'blob' }
])
const lines = table('shop', 'order_lines', [
  { name: 'order_id', key: 'PRI' },
  { name: 'line', key: 'PRI' },
  { name: 'qty' }
])
const report = table('shop', 'report', [{ name: 'id' }], { type: 'VIEW' })
const log = table('shop', 'log', [{ name: 'msg', type: 'text' }])
const files = table('shop', 'files', [{ name: 'hash', type: 'binary(16)', key: 'PRI' }, { name: 'name', type: 'text' }])
const locked = table('shop', 'locked', [{ name: 'id', key: 'PRI' }], { editDisabledReason: 'This SQLite connection is read-only' })

const driver = fakeDriver([customers, orders, lines, report, log, files, locked])

const field = (name: string, source?: string, extra: Partial<ResultField> = {}): ResultField => {
  if (!source) return { name, type: 'VAR_STRING', numeric: false, ...extra }
  const [t, column] = source.split('.')
  return { name, type: 'VAR_STRING', numeric: false, source: { schema: 'shop', table: t, column }, ...extra }
}

describe('resultEditInfo', () => {
  it('makes a single-table result with its primary key editable', async () => {
    const info = await resultEditInfo(driver, 'SELECT * FROM customers', [
      field('id', 'customers.id'),
      field('name', 'customers.name'),
      field('email', 'customers.email')
    ])
    expect(info.reason).toBeUndefined()
    expect(info.readOnly).toEqual({})
    expect(info.tables).toEqual([
      {
        schema: 'shop',
        table: 'customers',
        key: [{ column: 'id', field: 0 }],
        columns: [
          { field: 0, column: 'id', nullable: false },
          { field: 1, column: 'name', nullable: false },
          { field: 2, column: 'email', nullable: true }
        ]
      }
    ])
  })

  it('maps aliased fields to their table columns', async () => {
    const info = await resultEditInfo(driver, 'SELECT name AS n, id AS k FROM customers', [field('n', 'customers.name'), field('k', 'customers.id')])
    expect(info.tables[0].key).toEqual([{ column: 'id', field: 1 }])
    expect(info.tables[0].columns.map((c) => [c.field, c.column])).toEqual([[0, 'name'], [1, 'id']])
  })

  it('keeps calculated fields read-only while the rest stays editable', async () => {
    const info = await resultEditInfo(driver, 'SELECT id, name, UPPER(email) FROM customers', [
      field('id', 'customers.id'),
      field('name', 'customers.name'),
      field('UPPER(email)')
    ])
    expect(info.tables).toHaveLength(1)
    expect(info.readOnly).toEqual({ 2: 'Calculated column' })
  })

  it('needs every primary key column in the result', async () => {
    const info = await resultEditInfo(driver, 'SELECT name FROM customers', [field('name', 'customers.name')])
    expect(info.tables).toEqual([])
    expect(info.reason).toBe('Read-only: include id to edit customers')
    expect(info.readOnly).toEqual({ 0: 'Read-only: include id to edit customers' })

    const partial = await resultEditInfo(driver, 'SELECT order_id, qty FROM order_lines', [
      field('order_id', 'order_lines.order_id'),
      field('qty', 'order_lines.qty')
    ])
    expect(partial.reason).toBe('Read-only: include line to edit order_lines')
  })

  it('edits each joined table whose primary key is in the result', async () => {
    const info = await resultEditInfo(driver, 'SELECT o.id, o.status, c.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id', [
      field('id', 'orders.id'),
      field('status', 'orders.status'),
      field('id', 'customers.id'),
      field('name', 'customers.name')
    ])
    expect(info.tables.map((t) => [t.table, t.key, t.columns.map((c) => c.field)])).toEqual([
      ['orders', [{ column: 'id', field: 0 }], [0, 1]],
      ['customers', [{ column: 'id', field: 2 }], [2, 3]]
    ])
  })

  it('keeps a joined table without its primary key read-only', async () => {
    const info = await resultEditInfo(driver, 'SELECT o.id, o.status, c.name FROM orders o JOIN customers c ON c.id = o.customer_id', [
      field('id', 'orders.id'),
      field('status', 'orders.status'),
      field('name', 'customers.name')
    ])
    expect(info.tables.map((t) => t.table)).toEqual(['orders'])
    expect(info.readOnly).toEqual({ 2: 'Read-only: include id to edit customers' })
  })

  it('refuses a table that appears more than once', async () => {
    const info = await resultEditInfo(driver, 'SELECT a.id, b.id FROM customers a JOIN customers b', [field('id', 'customers.id'), field('id', 'customers.id')])
    expect(info.tables).toEqual([])
    expect(info.reason).toBe('Read-only: customers appears more than once in the result')
  })

  it('applies the table view rules', async () => {
    const view = await resultEditInfo(driver, 'SELECT id FROM report', [field('id', 'report.id')])
    expect(view.reason).toBe('Views are read-only')
    const noKey = await resultEditInfo(driver, 'SELECT msg FROM log', [field('msg', 'log.msg')])
    expect(noKey.reason).toBe('Read-only: table has no primary key')
    const binaryKey = await resultEditInfo(driver, 'SELECT hash, name FROM files', [field('hash', 'files.hash'), field('name', 'files.name')])
    expect(binaryKey.reason).toBe('Read-only: binary primary key')
    const readOnlyConnection = await resultEditInfo(driver, 'SELECT id FROM locked', [field('id', 'locked.id')])
    expect(readOnlyConnection.reason).toBe('This SQLite connection is read-only')
  })

  it('keeps generated and binary columns read-only', async () => {
    const info = await resultEditInfo(driver, 'SELECT id, total_cents, receipt FROM orders', [
      field('id', 'orders.id'),
      field('total_cents', 'orders.total_cents'),
      field('receipt', 'orders.receipt')
    ])
    expect(info.tables[0].columns.map((c) => c.column)).toEqual(['id'])
    expect(info.readOnly).toEqual({ 1: 'Generated or binary column', 2: 'Generated or binary column' })
  })

  it('refuses rows addressed by unsafe key values', async () => {
    const info = await resultEditInfo(driver, 'SELECT id, name FROM customers', [field('id', 'customers.id', { unsafeKey: true }), field('name', 'customers.name')])
    expect(info.reason).toBe('Read-only: customers has primary keys that cannot be edited safely')
  })

  it('reports tables it cannot look up', async () => {
    const info = await resultEditInfo(driver, 'SELECT id FROM gone', [field('id', 'gone.id')])
    expect(info.reason).toBe('Table not found: shop.gone')
  })

  it('edits nothing unless the query is a plain SELECT', async () => {
    const info = await resultEditInfo(driver, 'WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d', [field('id', 'customers.id')])
    expect(info).toEqual({ tables: [], readOnly: {}, reason: 'Only results of a single SELECT statement can be edited' })
  })

  it('explains a result with no table columns', async () => {
    const info = await resultEditInfo(driver, 'SELECT 1 + 1', [field('1 + 1')])
    expect(info.tables).toEqual([])
    expect(info.reason).toBe('Read-only: no column comes straight from a table')
  })
})
