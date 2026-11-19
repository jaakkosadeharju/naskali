import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectionIdentity, loadLegacyFavourites, loadLegacySavedQueries, loadWorkspace, procedureKey, removeWorkspace, saveWorkspace, tableKey } from '../workspaceStore'
import type { ConnectionConfig } from '../../../shared/types'

const workspace = {
  tabs: [{ id: 'query:1', kind: 'query' as const, number: 1, sql: '' }],
  activeId: 'query:1',
  lastQueryId: 'query:1'
}

beforeEach(() => {
  const entries = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key)
  })
})

it('reads legacy named queries by connection for migration', () => {
  const config: ConnectionConfig = {
    driver: 'mysql', host: 'localhost', port: 3306, user: 'dev', password: 'secret', database: 'shop'
  }
  const profile = connectionIdentity(config, 'shop-profile')
  const direct = connectionIdentity(config, null)
  const query = { id: 'query-id', name: 'Orders', sql: 'SELECT * FROM orders;\n' }
  localStorage.setItem(`naskali.saved-queries.v1.${profile}`, JSON.stringify([query]))
  localStorage.setItem(`naskali.saved-queries.v1.${direct}`, JSON.stringify([query]))
  expect(loadLegacySavedQueries(profile)).toEqual([query])
  expect(loadLegacySavedQueries(connectionIdentity({ ...config, database: 'other' }, null))).toEqual([])
  expect(direct).not.toContain(config.password)
  removeWorkspace('shop-profile')
  expect(loadLegacySavedQueries(profile)).toEqual([])
  expect(loadLegacySavedQueries(direct)).toEqual([query])
})

afterEach(() => vi.unstubAllGlobals())

it('reads legacy workspace favourites for migration', () => {
  const identity = connectionIdentity({ driver: 'sqlite', file: '/tmp/shop.db' }, 'shop')
  const favourite = tableKey('main', 'orders')
  saveWorkspace('shop', { ...workspace, favourites: [favourite] })
  expect(loadLegacyFavourites(identity, loadWorkspace('shop')?.favourites)).toEqual([favourite])
  expect(tableKey('a.b', 'c')).not.toBe(tableKey('a', 'b.c'))
})

it('keeps procedure favourites separate from tables and views with the same name', () => {
  expect(procedureKey('sales', 'orders')).not.toBe(tableKey('sales', 'orders'))
  expect(procedureKey('sales', 'orders')).not.toBe(procedureKey('archive', 'orders'))
})

it('restores a saved query tab link and its edited draft', () => {
  const tabs = [{ ...workspace.tabs[0], savedQueryId: 'saved-orders', sql: 'SELECT * FROM orders WHERE id = 1' }]
  saveWorkspace('shop', { ...workspace, tabs })
  expect(loadWorkspace('shop')?.tabs).toEqual(tabs)
})
