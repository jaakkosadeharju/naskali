import { describe, expect, it } from 'vitest'
import { queryShape } from '../queryShape'
import { SPLIT_RULES } from '../../shared/sqlSplit'

const reads = (sql: string, rules = SPLIT_RULES.mysql): Record<string, number> => Object.fromEntries(queryShape(sql, rules).reads)

describe('queryShape', () => {
  it('counts the tables read in FROM and JOIN clauses', () => {
    expect(reads('SELECT * FROM customers')).toEqual({ customers: 1 })
    expect(reads('SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id')).toEqual({ orders: 1, customers: 1 })
  })

  it('counts a table joined to itself twice', () => {
    expect(reads('SELECT a.id, b.email FROM customers a JOIN customers b ON b.id = a.id + 1')).toEqual({ customers: 2 })
    expect(reads('SELECT a.id, b.email FROM customers a, customers AS b WHERE b.id = a.id')).toEqual({ customers: 2 })
  })

  it('names tables by their last, unquoted, lower-case name part', () => {
    expect(reads('SELECT * FROM shop.`Customers` JOIN `orders` USING (id)')).toEqual({ customers: 1, orders: 1 })
    expect(reads('SELECT * FROM "public"."Customers"', SPLIT_RULES.postgres)).toEqual({ customers: 1 })
    expect(reads('SELECT * FROM [shop].[dbo].[customers] WITH (NOLOCK)', SPLIT_RULES.mssql)).toEqual({ customers: 1 })
    expect(reads('SELECT * FROM ONLY customers', SPLIT_RULES.postgres)).toEqual({ customers: 1 })
  })

  it('ignores commas outside the FROM list', () => {
    expect(reads('SELECT id, name FROM customers WHERE id IN (1, 2) ORDER BY name, id')).toEqual({ customers: 1 })
    expect(reads('SELECT id FROM customers FOR UPDATE OF customers, orders', SPLIT_RULES.postgres)).toEqual({ customers: 1 })
  })

  it('counts tables in subqueries and derived tables, not their aliases', () => {
    expect(reads('SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders)')).toEqual({ customers: 1, orders: 1 })
    expect(reads('SELECT * FROM (SELECT id, name FROM products) AS customers, orders')).toEqual({ products: 1, orders: 1 })
  })

  it('skips table functions', () => {
    expect(reads('SELECT * FROM generate_series(1, 3) g, LATERAL unnest(ARRAY[1, 2]) u, customers', SPLIT_RULES.postgres)).toEqual({ customers: 1 })
  })

  it('ignores names in strings and comments', () => {
    expect(reads("SELECT 'from customers' FROM orders -- join customers\n/* , customers */")).toEqual({ orders: 1 })
  })

  it('finds common table expressions and their uses', () => {
    const shape = queryShape('WITH c AS (SELECT * FROM customers), d (x) AS (SELECT 1) SELECT * FROM c JOIN c AS c2 ON true, d')
    expect([...shape.ctes]).toEqual(['c', 'd'])
    expect(Object.fromEntries(shape.reads)).toEqual({ customers: 1, c: 2, d: 1 })
    const pg = queryShape('WITH RECURSIVE "R" AS NOT MATERIALIZED (SELECT 1) SELECT * FROM "R"', SPLIT_RULES.postgres)
    expect([...pg.ctes]).toEqual(['r'])
  })

  it('detects set operations', () => {
    expect(queryShape('SELECT id FROM customers UNION ALL SELECT id FROM products').setOperation).toBe(true)
    expect(queryShape('SELECT id FROM customers WHERE id IN (SELECT 1 INTERSECT SELECT 2)').setOperation).toBe(true)
    expect(queryShape('SELECT id FROM customers EXCEPT SELECT id FROM products').setOperation).toBe(true)
    expect(queryShape("SELECT 'union' AS `except` FROM customers").setOperation).toBe(false)
  })
})
