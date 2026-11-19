import { describe, expect, it } from 'vitest'
import { DIALECTS } from '../dialect'
import { primaryKeyLookupSql, type ColumnMeta } from '../tableQuery'

const id: ColumnMeta = { name: 'position_id', type: 'bigint', key: 'PRI', extra: '', nullable: false }

describe('primary-key lookup SQL', () => {
  it('quotes identifiers and keeps large numeric keys intact', () => {
    expect(primaryKeyLookupSql(DIALECTS.mysql, 'shop', 'Position', '9007199254740993', [id]))
      .toBe('SELECT * FROM `shop`.`Position` WHERE `position_id` = 9007199254740993;')
    expect(primaryKeyLookupSql(DIALECTS.mssql, 'dbo', 'Some]Table', '-123', [id]))
      .toBe('SELECT * FROM [dbo].[Some]]Table] WHERE [position_id] = -123;')
  })

  it('treats text IDs as literals even when they look numeric', () => {
    const textId = { ...id, type: 'text' }
    expect(primaryKeyLookupSql(DIALECTS.sqlite, 'main', 'Position', '00123', [textId]))
      .toBe(`SELECT * FROM "main"."Position" WHERE "position_id" = '00123';`)
    expect(primaryKeyLookupSql(DIALECTS.postgres, 'public', 'Position', "O'Brien#12", [textId]))
      .toBe(`SELECT * FROM "public"."Position" WHERE "position_id" = 'O''Brien#12';`)
  })

  it('quotes text lookups independent of connection escape modes', () => {
    const textId = { ...id, type: 'text' }
    expect(primaryKeyLookupSql(DIALECTS.mysql, 'shop', 'Position', "O'Brien", [textId]))
      .toContain("= 'O''Brien';")
    expect(primaryKeyLookupSql(DIALECTS.mysql, 'shop', 'Position', 'a\\b', [textId]))
      .toContain("= CONVERT(X'615c62' USING utf8mb4);")
    expect(primaryKeyLookupSql(DIALECTS.postgres, 'public', 'Position', 'a\\b', [textId]))
      .toContain("= E'a\\\\b';")
  })

  it('rejects absent or composite keys and invalid integer input', () => {
    const lookup = (value: string, columns: ColumnMeta[]) => primaryKeyLookupSql(DIALECTS.mysql, 'shop', 'Position', value, columns)
    expect(() => lookup('123', [])).toThrow(/single-column primary key/)
    expect(() => lookup('123', [id, { ...id, name: 'other_id' }])).toThrow(/single-column primary key/)
    expect(() => lookup('123.5', [id])).toThrow(/integer primary-key/)
    expect(() => lookup('', [id])).toThrow(/valid primary-key/)
  })
})
