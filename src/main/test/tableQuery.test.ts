import { describe, expect, it } from 'vitest'
import { DIALECTS, render } from '../dialect'
import { buildChangeStatements, type ColumnMeta } from '../tableQuery'
import type { CellAssignment, DriverKind } from '../../shared/types'

const columns: ColumnMeta[] = [
  { name: 'id', type: 'int', key: 'PRI', nullable: false, extra: '' },
  { name: 'status', type: 'varchar(20)', key: '', nullable: false, default: "'new'", extra: '' },
  { name: 'created', type: 'date', key: '', nullable: false, extra: '' },
  { name: 'updated', type: 'datetimeoffset(7)', key: '', nullable: true, extra: '' }
]

function update(driver: DriverKind, set: Record<string, CellAssignment>) {
  const d = DIALECTS[driver]
  return render(buildChangeStatements(d, {
    schema: 'main', table: 'orders', updates: [{ key: { id: 1 }, set }], deletes: [], inserts: []
  }, columns)[0], d)
}

describe('quick cell assignments', () => {
  it('allows Now for a MySQL timestamp default but keeps generated columns read-only', () => {
    const d = DIALECTS.mysql
    const change = {
      schema: 'shop', table: 'customers', deletes: [], inserts: [],
      updates: [{ key: { id: 1 }, set: { created_at: { kind: 'current' } as const } }]
    }
    const created = { name: 'created_at', type: 'datetime', key: '', nullable: false, default: 'CURRENT_TIMESTAMP' }
    const statements = buildChangeStatements(d, change, [columns[0], { ...created, extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' }])
    expect(render(statements[0], d)).toEqual({
      text: 'UPDATE `shop`.`customers` SET `created_at` = CURRENT_TIMESTAMP WHERE `id` = ? LIMIT 1',
      params: [1]
    })
    for (const extra of ['VIRTUAL GENERATED', 'STORED GENERATED']) {
      expect(() => buildChangeStatements(d, change, [columns[0], { ...created, extra }])).toThrow(/not editable/)
    }
  })

  it('emits DEFAULT and current dates with a bound row key and bound literal values', () => {
    expect(update('postgres', { status: { kind: 'default' }, created: { kind: 'current' }, updated: null })).toEqual({
      text: 'UPDATE "main"."orders" SET "status" = DEFAULT, "created" = CURRENT_DATE, "updated" = $1 WHERE "id" = $2',
      params: [null, 1]
    })
    expect(update('mysql', { status: 'DEFAULT' }).params).toEqual(['DEFAULT', 1])
  })

  it('uses SQL Server clock expressions for date and offset datetime columns', () => {
    expect(update('mssql', { created: { kind: 'current' }, updated: { kind: 'current' } }).text)
      .toContain('[created] = CONVERT(date, SYSDATETIME()), [updated] = SYSDATETIMEOFFSET()')
  })

  it('rejects unavailable defaults, inappropriate clock values and NULL on a required column', () => {
    expect(() => update('sqlite', { status: { kind: 'default' } })).toThrow(/DEFAULT is unavailable/)
    expect(() => update('mysql', { created: { kind: 'default' } })).toThrow(/DEFAULT is unavailable/)
    expect(() => update('mysql', { status: { kind: 'current' } })).toThrow(/Current date or time is unavailable/)
    expect(() => update('mssql', { status: null })).toThrow(/cannot be NULL/)
  })
})
