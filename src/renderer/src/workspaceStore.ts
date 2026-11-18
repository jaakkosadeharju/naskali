import { FILTER_OPS, type RowFilter } from '../../shared/types'

export interface TableFilter {
  filters: RowFilter[]
  match: 'all' | 'any'
}

export type WorkspaceTab =
  | { id: string; kind: 'query'; number: number; sql: string; split?: number }
  | { id: string; kind: 'table'; schema: string; table: string; view: 'data' | 'schema'; filters?: RowFilter[]; applied?: TableFilter }

interface Workspace {
  tabs: WorkspaceTab[]
  activeId: string
  lastQueryId: string
}

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
      typeof tab.sql === 'string' && (tab.split === undefined || (Number.isFinite(tab.split) && tab.split >= 20 && tab.split <= 80))
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
    return saved
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
  } catch {
    /* Storage unavailable. */
  }
}
