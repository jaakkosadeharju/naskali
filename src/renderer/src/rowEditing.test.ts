import { describe, expect, it } from 'vitest'
import {
  addInsert,
  canEdit,
  countChanges,
  dropInserts,
  emptyStaged,
  isDeleted,
  isEdited,
  overlay,
  revertEdit,
  setInsertValue,
  stageEdit,
  toChangeSets,
  toggleDelete,
  type EditTarget
} from './rowEditing'
import type { CellValue } from '../../shared/types'

// Result: o.id, o.status, c.id, c.name, UPPER(c.name)
const orders: EditTarget = {
  schema: 'shop',
  table: 'orders',
  key: [{ column: 'id', field: 0 }],
  columns: [
    { field: 0, column: 'id', nullable: false },
    { field: 1, column: 'status', nullable: true }
  ]
}
const customers: EditTarget = {
  schema: 'shop',
  table: 'customers',
  key: [{ column: 'id', field: 2 }],
  columns: [
    { field: 2, column: 'id', nullable: false },
    { field: 3, column: 'name', nullable: false }
  ]
}
const joined = [orders, customers]
const rows: CellValue[][] = [
  [1, 'new', 10, 'Ada', 'ADA'],
  [2, 'paid', 10, 'Ada', 'ADA'],
  [3, 'new', 11, 'Bob', 'BOB'],
  [4, 'new', null, null, null] // LEFT JOIN without a customer
]

describe('staging edits', () => {
  it('shows an edit on every row of the same table row', () => {
    const staged = stageEdit(emptyStaged, joined, rows[0], 3, 'Ada L.')
    expect(overlay(staged, joined, rows).map((r) => r[3])).toEqual(['Ada L.', 'Ada L.', 'Bob', null])
    expect([0, 1, 2].map((i) => isEdited(staged, joined, rows[i], 3))).toEqual([true, true, false])
    expect(isEdited(staged, joined, rows[0], 1)).toBe(false)
  })

  it('drops an edit set back to the original value', () => {
    const edited = stageEdit(emptyStaged, joined, rows[0], 1, 'paid')
    expect(countChanges(edited).updated).toBe(1)
    expect(countChanges(stageEdit(edited, joined, rows[0], 1, 'new')).updated).toBe(0)
    expect(countChanges(revertEdit(edited, joined, rows[0], 1)).updated).toBe(0)
  })

  it('compares numbers and their text loosely', () => {
    expect(countChanges(stageEdit(emptyStaged, joined, rows[0], 0, '1')).updated).toBe(0)
  })

  it('keeps calculated columns and rows without a key read-only', () => {
    expect(canEdit(joined, rows[0], 3)).toBe(true)
    expect(canEdit(joined, rows[0], 4)).toBe(false)
    expect(canEdit(joined, rows[3], 1)).toBe(true)
    expect(canEdit(joined, rows[3], 3)).toBe(false)
    expect(stageEdit(emptyStaged, joined, rows[3], 3, 'x')).toBe(emptyStaged)
  })

  it('builds one change set per table with real column names', () => {
    let staged = stageEdit(emptyStaged, joined, rows[0], 1, 'shipped')
    staged = stageEdit(staged, joined, rows[1], 3, 'Ada L.')
    staged = stageEdit(staged, joined, rows[2], 3, 'Robert')
    expect(toChangeSets(staged, joined)).toEqual([
      { schema: 'shop', table: 'orders', deletes: [], inserts: [], updates: [{ key: { id: 1 }, set: { status: 'shipped' } }] },
      {
        schema: 'shop',
        table: 'customers',
        deletes: [],
        inserts: [],
        updates: [
          { key: { id: 10 }, set: { name: 'Ada L.' } },
          { key: { id: 11 }, set: { name: 'Robert' } }
        ]
      }
    ])
  })

  it('maps aliased fields back to their columns', () => {
    const aliased: EditTarget = { schema: 's', table: 't', key: [{ column: 'id', field: 1 }], columns: [{ field: 0, column: 'name', nullable: false }, { field: 1, column: 'id', nullable: false }] }
    const staged = stageEdit(emptyStaged, [aliased], ['x', 5], 0, 'y')
    expect(toChangeSets(staged, [aliased])[0].updates).toEqual([{ key: { id: 5 }, set: { name: 'y' } }])
    expect(overlay(staged, [aliased], [['x', 5]])).toEqual([['y', 5]])
  })
})

describe('deleting rows', () => {
  const single = [orders]

  it('toggles rows and drops their pending edits', () => {
    let staged = stageEdit(emptyStaged, single, rows[0], 1, 'paid')
    staged = toggleDelete(staged, single, [rows[0], rows[1]])
    expect(countChanges(staged)).toEqual({ inserted: 0, updated: 0, deleted: 2 })
    expect(isDeleted(staged, single, rows[0])).toBe(true)
    expect(toChangeSets(staged, single)[0].deletes).toEqual([{ key: { id: 1 } }, { key: { id: 2 } }])
    staged = toggleDelete(staged, single, [rows[0], rows[1]])
    expect(countChanges(staged).deleted).toBe(0)
  })

  it('marks all when only some are marked', () => {
    const staged = toggleDelete(toggleDelete(emptyStaged, single, [rows[0]]), single, [rows[0], rows[1]])
    expect(countChanges(staged).deleted).toBe(2)
  })
})

describe('inserting rows', () => {
  it('adds new rows to the first table only', () => {
    let staged = addInsert(emptyStaged, 7)
    staged = setInsertValue(staged, 7, 'status', 'new')
    staged = addInsert(staged, 8)
    expect(staged.inserts.map((r) => r.id)).toEqual([8, 7])
    staged = dropInserts(staged, [8])
    expect(countChanges(staged).inserted).toBe(1)
    expect(toChangeSets(staged, [orders])).toEqual([
      { schema: 'shop', table: 'orders', deletes: [], updates: [], inserts: [{ values: { status: 'new' } }] }
    ])
  })
})
