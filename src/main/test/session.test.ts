import { describe, expect, it } from 'vitest'
import { applyChanges, previewChanges } from '../session'
import { fakeDriver, table } from './fakeDriver'
import type { ChangeSet } from '../../shared/types'

const tables = () => [
  table('shop', 'customers', [{ name: 'id', key: 'PRI' }, { name: 'name', type: 'varchar(100)' }]),
  table('shop', 'orders', [{ name: 'id', key: 'PRI' }, { name: 'status', type: 'varchar(20)' }])
]

const sets: ChangeSet[] = [
  { schema: 'shop', table: 'orders', deletes: [{ key: { id: 7 } }], updates: [{ key: { id: 1 }, set: { status: 'paid' } }], inserts: [] },
  { schema: 'shop', table: 'customers', deletes: [], updates: [{ key: { id: 2 }, set: { name: 'Ada' } }], inserts: [] }
]

describe('applyChanges', () => {
  it('runs every change set in one transaction', async () => {
    const driver = fakeDriver(tables())
    expect(await applyChanges(driver, sets)).toEqual({ deleted: 1, updated: 2, inserted: 0 })
    expect(driver.transactions).toEqual(['commit'])
    expect(driver.executed).toEqual([
      { text: 'DELETE FROM `shop`.`orders` WHERE `id` = ? LIMIT 1', params: [7] },
      { text: 'UPDATE `shop`.`orders` SET `status` = ? WHERE `id` = ? LIMIT 1', params: ['paid', 1] },
      { text: 'UPDATE `shop`.`customers` SET `name` = ? WHERE `id` = ? LIMIT 1', params: ['Ada', 2] }
    ])
  })

  it('rolls everything back when a statement matches no row', async () => {
    const driver = fakeDriver(tables())
    driver.affected = [1, 1, 0]
    await expect(applyChanges(driver, sets)).rejects.toThrow(/No row matched.*Nothing was saved/s)
    expect(driver.transactions).toEqual(['rollback'])
  })

  it('validates every change set before starting', async () => {
    const driver = fakeDriver(tables())
    const bad: ChangeSet = { ...sets[1], updates: [{ key: { id: 2 }, set: { nope: 1 } }] }
    await expect(applyChanges(driver, [sets[0], bad])).rejects.toThrow('Unknown column: nope')
    expect(driver.transactions).toEqual([])
  })
})

describe('previewChanges', () => {
  it('lists the statements of every change set', async () => {
    expect(await previewChanges(fakeDriver(tables()), sets)).toEqual([
      'DELETE FROM `shop`.`orders` WHERE `id` = 7 LIMIT 1;',
      "UPDATE `shop`.`orders` SET `status` = 'paid' WHERE `id` = 1 LIMIT 1;",
      "UPDATE `shop`.`customers` SET `name` = 'Ada' WHERE `id` = 2 LIMIT 1;"
    ])
  })
})
