import { describe, expect, it } from 'vitest'
import { DIALECTS } from '../dialect'
import { rowLookupSql, type ColumnMeta } from '../tableQuery'

const id: ColumnMeta = { name: 'position_id', type: 'bigint', key: 'PRI', extra: '', nullable: false }

describe('row lookup SQL', () => {
  it('quotes identifiers and keeps large numeric keys intact', () => {
    expect(rowLookupSql(DIALECTS.mysql, 'shop', 'Position', '9007199254740993', [id]))
      .toBe('SELECT * FROM `shop`.`Position` WHERE `position_id` = 9007199254740993;')
    expect(rowLookupSql(DIALECTS.mssql, 'dbo', 'Some]Table', '-123', [id]))
      .toBe('SELECT * FROM [dbo].[Some]]Table] WHERE [position_id] = -123;')
  })

  it('treats text IDs as literals even when they look numeric', () => {
    const textId = { ...id, type: 'text' }
    expect(rowLookupSql(DIALECTS.sqlite, 'main', 'Position', '00123', [textId]))
      .toBe(`SELECT * FROM "main"."Position" WHERE "position_id" = '00123';`)
    expect(rowLookupSql(DIALECTS.postgres, 'public', 'Position', "O'Brien#12", [textId]))
      .toBe(`SELECT * FROM "public"."Position" WHERE "position_id" = 'O''Brien#12';`)
  })

  it('quotes text lookups independent of connection escape modes', () => {
    const textId = { ...id, type: 'text' }
    expect(rowLookupSql(DIALECTS.mysql, 'shop', 'Position', "O'Brien", [textId]))
      .toContain("= 'O''Brien';")
    expect(rowLookupSql(DIALECTS.mysql, 'shop', 'Position', 'a\\b', [textId]))
      .toContain("= CONVERT(X'615c62' USING utf8mb4);")
    expect(rowLookupSql(DIALECTS.postgres, 'public', 'Position', 'a\\b', [textId]))
      .toContain("= E'a\\\\b';")
  })

  it('rejects absent or composite keys and invalid integer input', () => {
    const lookup = (value: string, columns: ColumnMeta[]) => rowLookupSql(DIALECTS.mysql, 'shop', 'Position', value, columns)
    expect(() => lookup('123', [])).toThrow(/single-column primary key/)
    expect(() => lookup('123', [id, { ...id, name: 'other_id' }])).toThrow(/single-column primary key/)
    expect(() => lookup('123.5', [id])).toThrow(/integer primary-key/)
    expect(() => lookup('', [id])).toThrow(/valid primary-key/)
  })
})

describe('explicit lookup columns', () => {
  const itemId = { ...id, name: 'item_id', type: 'text', key: '' }

  it('looks up a text value on a table without a primary key', () => {
    expect(rowLookupSql(DIALECTS.postgres, 'public', 'Position', "item_id = 001=O'Brien", [itemId]))
      .toBe(`SELECT * FROM "public"."Position" WHERE "item_id" = '001=O''Brien';`)
  })

  it('quotes the column name and preserves numeric precision', () => {
    const column = { ...itemId, name: 'item]id', type: 'bigint' }
    expect(rowLookupSql(DIALECTS.mssql, 'dbo', 'Position', 'item]id=9007199254740993', [column]))
      .toBe('SELECT * FROM [dbo].[Position] WHERE [item]]id] = 9007199254740993;')
    expect(() => rowLookupSql(DIALECTS.mssql, 'dbo', 'Position', 'item]id=12.5', [column]))
      .toThrow(/integer lookup value/)
  })

  it('rejects unknown columns and missing values', () => {
    expect(() => rowLookupSql(DIALECTS.mysql, 'shop', 'Position', 'missing=42', [itemId]))
      .toThrow(/Unknown column: missing/)
    expect(() => rowLookupSql(DIALECTS.mysql, 'shop', 'Position', 'item_id=', [itemId]))
      .toThrow(/valid lookup value/)
  })
})

describe('lookup operators', () => {
  const lookup = (expression: string) => rowLookupSql(DIALECTS.sqlite, 'main', 'Position', expression, [id])

  it.each(['<=', '<', '>=', '>'])('supports %s and retains large integers', (operator) => {
    expect(lookup(`position_id ${operator} 9007199254740993`))
      .toBe(`SELECT * FROM "main"."Position" WHERE "position_id" ${operator} 9007199254740993;`)
  })

  it.each(['IS NULL', 'IS NOT NULL'])('supports %s without a value', (operator) => {
    expect(lookup(`position_id ${operator.toLowerCase().replaceAll(' ', '  ')}`))
      .toBe(`SELECT * FROM "main"."Position" WHERE "position_id" ${operator};`)
  })

  it('rejects unknown columns and invalid comparison values', () => {
    expect(() => lookup('missing IS NULL')).toThrow(/Unknown column: missing/)
    expect(() => lookup('position_id>')).toThrow(/valid lookup value/)
    expect(() => lookup('position_id<=1 OR 1=1')).toThrow(/integer lookup value/)
  })

  it('keeps operator characters in text on the right of a comparison', () => {
    expect(rowLookupSql(DIALECTS.sqlite, 'main', 'Position', 'position_id=a>=b IS NULL', [{ ...id, type: 'text' }]))
      .toBe(`SELECT * FROM "main"."Position" WHERE "position_id" = 'a>=b IS NULL';`)
  })
})
