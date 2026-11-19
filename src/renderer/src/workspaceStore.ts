import { FILTER_OPS, type ConnectionConfig, type RowFilter, type SavedQuery } from '../../shared/types'

const savedQueryKey = (identity: string): string => `naskali.saved-queries.v1.${identity}`
const favouritesKey = (identity: string): string => `naskali.favourites.v1.${identity}`
const profileIdentity = (profileId: string): string => JSON.stringify(['profile', profileId])

export function connectionIdentity(config: ConnectionConfig, profileId: string | null): string {
  if (profileId) return profileIdentity(profileId)
  if (config.driver === 'sqlite') return JSON.stringify([config.driver, config.file])
  return JSON.stringify([config.driver, config.host, config.port, config.user, config.database ?? ''])
}

export function loadLegacySavedQueries(identity: string): SavedQuery[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(savedQueryKey(identity)) ?? 'null')
    return Array.isArray(saved) ? saved.filter((query) => query && typeof query.id === 'string' &&
      typeof query.name === 'string' && typeof query.sql === 'string') : []
  } catch {
    return []
  }
}

export function loadLegacyFavourites(identity: string, legacy: string[] = []): string[] {
  try {
    const saved = localStorage.getItem(favouritesKey(identity))
    if (saved !== null) {
      const ids: unknown = JSON.parse(saved)
      if (Array.isArray(ids)) return ids.filter((id) => typeof id === 'string')
    }
  } catch {
    /* The legacy favourites remain available for this session. */
  }
  return legacy
}

export interface TableFilter {
  filters: RowFilter[]
  match: 'all' | 'any'
}

export type WorkspaceTab =
  | { id: string; kind: 'query'; number: number; sql: string; split?: number; savedQueryId?: string }
  | { id: string; kind: 'table'; schema: string; table: string; view: 'data' | 'schema'; filters?: RowFilter[]; applied?: TableFilter }

interface Workspace {
  tabs: WorkspaceTab[]
  activeId: string
  lastQueryId: string
  favourites?: string[]
}

export const tableKey = (schema: string, table: string): string => JSON.stringify([schema, table])
export const procedureKey = (schema: string, name: string): string => JSON.stringify(['procedure', schema, name])

const key = (profileId: string): string => `naskali.workspace.v1.${profileId}`

function validFilters(filters: unknown): filters is RowFilter[] {
  return Array.isArray(filters) && filters.every((filter) =>
    filter && typeof filter.column === 'string' && FILTER_OPS.includes(filter.op) && typeof filter.value === 'string'
  )
}

function validTab(tab: WorkspaceTab): boolean {
  if (!tab || typeof tab.id !== 'string') return false
  if (tab.kind === 'query') {
    return Number.isSafeInteger(tab.number) && tab.number > 0 && tab.id === `query:${tab.number}` &&
      typeof tab.sql === 'string' && (tab.savedQueryId === undefined || typeof tab.savedQueryId === 'string') &&
      (tab.split === undefined || (Number.isFinite(tab.split) && tab.split >= 20 && tab.split <= 80))
  }
  return tab.kind === 'table' && tab.id.startsWith('table:') &&
    typeof tab.schema === 'string' && typeof tab.table === 'string' &&
    (tab.view === 'data' || tab.view === 'schema') &&
    (tab.filters === undefined || validFilters(tab.filters)) &&
    (tab.applied === undefined || (tab.applied && validFilters(tab.applied.filters) &&
      (tab.applied.match === 'all' || tab.applied.match === 'any')))
}

export function loadWorkspace(profileId: string): Workspace | null {
  try {
    const saved: Workspace | null = JSON.parse(localStorage.getItem(key(profileId)) ?? 'null')
    if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.every(validTab)) return null
    if (!saved.tabs.some((tab) => tab.id === 'query:1') || new Set(saved.tabs.map((tab) => tab.id)).size !== saved.tabs.length) return null
    return { ...saved, favourites: Array.isArray(saved.favourites) ? saved.favourites.filter((id) => typeof id === 'string') : [] }
  } catch {
    return null
  }
}

export function saveWorkspace(profileId: string, workspace: Workspace): void {
  try {
    localStorage.setItem(key(profileId), JSON.stringify(workspace))
  } catch {
    /* Storage unavailable or full. The tabs stay open for this session. */
  }
}

export function removeWorkspace(profileId: string): void {
  try {
    localStorage.removeItem(key(profileId))
    localStorage.removeItem(savedQueryKey(profileIdentity(profileId)))
    localStorage.removeItem(favouritesKey(profileIdentity(profileId)))
  } catch {
    /* Storage unavailable. */
  }
}
