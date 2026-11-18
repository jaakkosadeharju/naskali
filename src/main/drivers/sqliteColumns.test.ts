import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fieldsOf } from './sqliteColumns'
import { toFields } from './sqlite'

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, quantity INTEGER);
`)
const describeSql = (sql: string) => fieldsOf(db.prepare(sql))

describe('fieldsOf', () => {
  it('reports the table column behind aliases and joins', () => {
    expect(describeSql('SELECT o.id AS k, o.quantity, c.name FROM orders o JOIN customers c ON c.id = o.customer_id')).toEqual([
      { name: 'k', type: 'INTEGER', source: { database: 'main', table: 'orders', column: 'id' } },
      { name: 'quantity', type: 'INTEGER', source: { database: 'main', table: 'orders', column: 'quantity' } },
      { name: 'name', type: 'TEXT', source: { database: 'main', table: 'customers', column: 'name' } }
    ])
  })

  it('reports no source for expressions', () => {
    expect(describeSql('SELECT UPPER(name) AS u, id + 1 FROM customers')).toEqual([
      { name: 'u', type: null },
      { name: 'id + 1', type: null }
    ])
  })
})

describe('toFields', () => {
  it('turns the database into the schema', () => {
    const [field] = toFields([{ name: 'id', type: 'INTEGER', source: { database: 'main', table: 'customers', column: 'id' } }], [[1n]])
    expect(field.source).toEqual({ schema: 'main', table: 'customers', column: 'id' })
    expect(field.unsafeKey).toBeUndefined()
  })

  it('marks columns whose values cannot address a row', () => {
    const fields = toFields(
      [
        { name: 'big', type: 'INTEGER' },
        { name: 'blob', type: 'BLOB' },
        { name: 'maybe', type: 'INTEGER' }
      ],
      [[2n ** 60n, new Uint8Array([1]), null]]
    )
    expect(fields.map((f) => !!f.unsafeKey)).toEqual([true, true, false])
  })
})
