import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { monaco } from './monacoSetup'
import { completionState } from './completion'
import { ConnectDialog } from './components/ConnectDialog'
import { TableDesigner, type DesignerRequest } from './components/TableDesigner'
import { SchemaTree } from './components/SchemaTree'
import { QuerySplit } from './components/QuerySplit'
import { SqlEditor, sqlToRun } from './components/SqlEditor'
import { QueryResultsView } from './components/QueryResultsView'
import { TableView, type TableViewMode } from './components/TableView'
import { ValueInspector } from './components/ValueInspector'
import { TablePalette } from './components/TablePalette'
import { SaveQueryDialog } from './components/SaveQueryDialog'
import { InspectorContext, type InspectedValue, type InspectorApi } from './inspector'
import { DRIVER_LABELS, type ConnectionColor, type ConnectionConfig, type ConnectionInfo, type EditorTransactionState, type QueryResult, type RowFilter, type SavedQuery, type SchemaInfo, type TableAction } from '../../shared/types'
import { setEditorDialect } from './monacoSetup'
import type { MenuCommand } from '../../shared/menuCommands'
import { MenuActionsContext, type RegisterMenuAction } from './menuActions'
import { connectionIdentity, loadLegacyFavourites, loadLegacySavedQueries, loadWorkspace, procedureKey, saveWorkspace, tableKey, type WorkspaceTab } from './workspaceStore'

interface Connection {
  /** e.g. "dev@127.0.0.1:5432/shop" or "shop.sqlite" */
  label: string
  color: ConnectionColor
  profileId: string | null
  storageIdentity: string
  readOnly: boolean
  info: ConnectionInfo
}

function connectionLabel(cfg: ConnectionConfig, info: ConnectionInfo): string {
  if (cfg.driver === 'sqlite') return cfg.file.split(/[\\/]/).pop() || cfg.file
  // MySQL's database is the switchable schema (shown separately); others are fixed per connection.
  const db = cfg.driver !== 'mysql' && info.database ? `/${info.database}` : ''
  return `${cfg.user}@${cfg.host}:${cfg.port}${db}`
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string; startedAt: number }
  /** `id` tells runs apart (a new one resets staged edits); `notice` is shown with the result. */
  | { status: 'done'; sql: string; result: QueryResult; id: number; notice?: string; transactional?: boolean }
  | { status: 'error'; sql: string; error: string }

let runCounter = 0

type QueryTab = Extract<WorkspaceTab, { kind: 'query' }> & { run: RunState; selectOnMount?: boolean; transaction?: EditorTransactionState | null; transactionBusy?: boolean; transactionMessage?: string }
type Tab = QueryTab | Extract<WorkspaceTab, { kind: 'table' }>

interface TabDrag {
  pointerId: number
  from: number
  startX: number
  startScroll: number
  bounds: { id: string; left: number; width: number }[]
  to: number
  moved: boolean
}

interface TabDrop {
  from: number
  to: number
  width: number
  shift: number
  offset: number
  slotLeft: number
}

function tabDragOffset(drag: TabDrop, index: number): number {
  if (index === drag.from) return drag.offset
  if (index > drag.from && index <= drag.to) return -drag.shift
  if (index < drag.from && index >= drag.to) return drag.shift
  return 0
}

const filterSummary = (filters: RowFilter[]): string => filters.map((f) => `${f.column} = ${f.value}`).join(', ')

const FIRST_QUERY: QueryTab = {
  id: 'query:1',
  kind: 'query',
  number: 1,
  run: { status: 'idle' },
  sql: '-- Ctrl+Enter runs the statement under the cursor or the selected SQL\nSELECT 1 AS example;\n'
}

const RECENT_TABLES_KEY = 'naskali.recentTables'
const MAX_RECENT = 20
function loadRecentTables(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_TABLES_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

const INSPECTOR_WIDTH_KEY = 'naskali.inspectorWidth'
const clampWidth = (w: number): number => Math.round(Math.min(Math.max(w, 260), window.innerWidth * 0.7))
function loadInspectorWidth(): number {
  try {
    const w = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY))
    return w > 0 ? clampWidth(w) : 420
  } catch {
    return 420
  }
}

export function App(): JSX.Element {
  const [conn, setConn] = useState<Connection | null>(null)
  const [currentDb, setCurrentDb] = useState<string | null>(null)
  const [switchingDatabase, setSwitchingDatabase] = useState(false)
  const [databaseError, setDatabaseError] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<SchemaInfo[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [favourites, setFavourites] = useState<Set<string>>(new Set())
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [sqlToSave, setSqlToSave] = useState<{ tabId: string; sql: string; savedQuery?: SavedQuery } | null>(null)
  const [explorerStorageError, setExplorerStorageError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState(FIRST_QUERY.id)
  const [procedureError, setProcedureError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [designer, setDesigner] = useState<DesignerRequest | null>(null)
  const [tableVersions, setTableVersions] = useState<Record<string, number>>({})
  const tabbar = useRef<HTMLElement>(null)
  const recentTabIds = useRef<string[]>([])
  const tabCycle = useRef<string[] | null>(null)
  const tabDrag = useRef<TabDrag | null>(null)
  const suppressTabClick = useRef(false)
  const [tabDrop, setTabDrop] = useState<TabDrop | null>(null)
  const editors = useRef(new Map<string, monaco.editor.IStandaloneCodeEditor>())
  const nextQueryNumber = useRef(2)
  const lastQueryId = useRef(FIRST_QUERY.id)
  const connectionGeneration = useRef(0)
  const runningQueries = useRef(new Set<string>())
  const querySchemas = useRef(new Map<string, string | null>())
  const defaultSchema = useRef<string | null>(null)
  // Tabs with unsaved row edits. Only read when closing, so a ref (no re-render) is enough.
  const dirtyTabs = useRef(new Set<string>())

  useEffect(() => {
    recentTabIds.current = [activeId, ...recentTabIds.current.filter((id) => id !== activeId)]
    tabbar.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  // ---- Table palette (Ctrl/Cmd+P) ----
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [recentTables, setRecentTables] = useState<string[]>(loadRecentTables)
  const focusBeforePalette = useRef<Element | null>(null)
  const connected = conn !== null
  useEffect(() => {
    // Capture phase: runs before Monaco and the grid get the key.
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        if (!connected || designer || switchingDatabase || sqlToSave !== null) return
        setPaletteOpen((open) => {
          if (!open) focusBeforePalette.current = document.activeElement
          return !open
        })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [connected, designer, switchingDatabase, sqlToSave])
  const closePalette = (): void => {
    setPaletteOpen(false)
    // Give focus back to where the user was (editor, grid…).
    const el = focusBeforePalette.current
    if (el instanceof HTMLElement) requestAnimationFrame(() => el.focus())
  }

  // ---- Value inspector (right panel) ----
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspected, setInspected] = useState<InspectedValue | null>(null)
  const [inspectorWidth, setInspectorWidth] = useState(loadInspectorWidth)
  const inspectorOwner = useRef<string | null>(null)
  // Memoized: grids push values from effects keyed on this object, so a new
  // object per render would make them push (and re-render the app) forever.
  const inspectorApi = useMemo<InspectorApi>(
    () => ({ open: inspectorOpen, setOpen: setInspectorOpen, show: setInspected, ownerRef: inspectorOwner }),
    [inspectorOpen]
  )
  const resizeInspector = useCallback((w: number) => {
    const width = clampWidth(w)
    setInspectorWidth(width)
    try {
      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(width))
    } catch {
      /* not persisted; fine */
    }
  }, [])
  // Ctrl+I toggles the panel anywhere except inside the SQL editor (Monaco uses it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        if ((e.target as HTMLElement | null)?.closest?.('.monaco-editor')) return
        e.preventDefault()
        setInspectorOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const updateDb = useCallback((db: string | null) => {
    setCurrentDb(db)
    setDatabaseError(null)
    completionState.currentDb = db
  }, [])

  const showQuerySchema = (id: string): void => {
    const schema = querySchemas.current.get(id)
    updateDb(schema === undefined ? defaultSchema.current : schema)
  }

  const refreshSchema = useCallback(async () => {
    const generation = connectionGeneration.current
    const r = await window.api.introspect()
    if (r.ok && generation === connectionGeneration.current) {
      setSchemas(r.value)
      completionState.schemas = r.value
    }
  }, [])

  const onConnected = useCallback(
    async (cfg: ConnectionConfig, info: ConnectionInfo, color: ConnectionColor, profileId: string | null) => {
      const workspace = profileId ? loadWorkspace(profileId) : null
      const identity = connectionIdentity(cfg, profileId)
      const legacy = loadLegacyFavourites(identity, workspace?.favourites)
      const legacyQueries = loadLegacySavedQueries(identity)
      const [savedFavourites, storedQueries] = await Promise.all([
        window.api.loadFavourites(identity, legacy),
        window.api.loadSavedQueries(identity, legacyQueries)
      ])
      const restored = workspace?.tabs.map((tab): Tab =>
        tab.kind === 'query' ? { ...tab, run: { status: 'idle' } } : tab
      ) ?? [FIRST_QUERY]
      lastQueryId.current = restored.find((tab) =>
        tab.kind === 'query' && tab.id === workspace?.lastQueryId
      )?.id ?? FIRST_QUERY.id
      nextQueryNumber.current = restored.reduce((next, tab) =>
        tab.kind === 'query' ? Math.max(next, tab.number + 1) : next, 2
      )
      recentTabIds.current = []
      tabCycle.current = null
      setFavourites(new Set(savedFavourites.ok ? savedFavourites.value : legacy))
      setSavedQueries(storedQueries.ok ? storedQueries.value : legacyQueries)
      setExplorerStorageError(!storedQueries.ok ? `Could not load saved queries. ${storedQueries.error}`
        : !savedFavourites.ok ? `Could not load favourites. ${savedFavourites.error}` : null)
      setTabs(restored)
      setActiveId(restored.find((tab) => tab.id === workspace?.activeId)?.id ?? lastQueryId.current)
      connectionGeneration.current++
      setConn({ label: connectionLabel(cfg, info), color, profileId, storageIdentity: identity, info, readOnly: cfg.driver === 'sqlite' && !!cfg.readOnly })
      setEditorDialect(info.driver)
      defaultSchema.current = info.schema
      querySchemas.current.clear()
      updateDb(info.schema)
      void refreshSchema()
    },
    [refreshSchema, updateDb]
  )

  const profileId = conn?.profileId
  useEffect(() => {
    if (!profileId) return
    const savedTabs = tabs.map((tab): WorkspaceTab => {
      if (tab.kind === 'table') return tab
      const { id, kind, number, sql, split, savedQueryId } = tab
      return { id, kind, number, sql, split, savedQueryId }
    })
    saveWorkspace(profileId, { tabs: savedTabs, activeId, lastQueryId: lastQueryId.current })
  }, [profileId, tabs, activeId])

  const disconnect = async (): Promise<void> => {
    if (runningQueries.current.size || disconnecting || switchingDatabase) return
    if (dirtyTabs.current.size > 0 && !window.confirm('Some tabs have unsaved changes. Discard them and disconnect?')) return
    if (tabs.some((tab) => tab.kind === 'query' && tab.transaction) &&
      !window.confirm('Roll back open transactions and disconnect?')) return
    setDisconnecting(true)
    setProcedureError(null)
    await window.api.disconnect()
    connectionGeneration.current++
    dirtyTabs.current.clear()
    editors.current.clear()
    lastQueryId.current = FIRST_QUERY.id
    setConn(null)
    setSchemas([])
    completionState.schemas = []
    setTabs([])
    setTableVersions({})
    setActiveId(FIRST_QUERY.id)
    setInspected(null)
    setPaletteOpen(false)
    setDisconnecting(false)
  }

  const canExecute = (): boolean => !!conn && !disconnecting && !switchingDatabase && !designer

  const execute = (id: string, statementOnly = false): void => {
    const editor = editors.current.get(id)
    if (!canExecute() || runningQueries.current.has(id)) return
    const sql = editor && sqlToRun(editor, statementOnly)
    if (!sql) return
    if (dirtyTabs.current.has(id) && !window.confirm('Discard unsaved changes to the results?')) return
    void runSql(id, sql)
  }

  /** Runs `sql` in query tab `id`; `notice` is shown with its result (e.g. after saving edits). */
  const runSql = async (id: string, sql: string, notice?: string): Promise<void> => {
    if (!canExecute() || runningQueries.current.has(id)) return
    const tab = tabs.find((item): item is QueryTab => item.id === id && item.kind === 'query')
    const transactional = !!tab?.transaction
    if (tab?.transaction?.rollbackOnly) return
    if (transactional) patchTransaction(id, { transactionMessage: undefined })
    dirtyTabs.current.delete(id)
    const setRun = (run: RunState): void => {
      setTabs((ts) => ts.map((t) => t.kind === 'query' && t.id === id ? { ...t, run } : t))
    }
    runningQueries.current.add(id)
    setRun({ status: 'running', sql, startedAt: Date.now() })
    try {
      const r = await window.api.query(id, sql)
      if (!r.ok) {
        setRun({ status: 'error', sql, error: r.error })
        return
      }
      setRun({ status: 'done', sql, result: r.value.result, id: ++runCounter, notice, transactional })
      querySchemas.current.set(id, r.value.schema)
      if (lastQueryId.current === id) updateDb(r.value.schema)
      // DDL changes the schema; keep the tree and autocomplete in sync.
      if (!transactional && /^\s*(create|alter|drop|rename|truncate)\b/i.test(sql)) void refreshSchema()
    } catch (error) {
      setRun({ status: 'error', sql, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (transactional) {
        const status = await window.api.editorTransaction(id, 'status').catch(() => null)
        if (status?.ok) {
          patchTransaction(id, {
            transaction: status.value,
            transactionMessage: status.value ? undefined : 'Transaction ended on the server.'
          })
          if (!status.value) void refreshSchema()
        } else {
          patchTransaction(id, {
            transaction: { statements: tab?.transaction?.statements ?? 0, rollbackOnly: true },
            transactionMessage: 'Could not check the transaction status.'
          })
        }
      }
      runningQueries.current.delete(id)
    }
  }

  const patchTransaction = (id: string, patch: Partial<Pick<QueryTab, 'transaction' | 'transactionBusy' | 'transactionMessage'>>): void => {
    setTabs((current) => current.map((tab) => tab.kind === 'query' && tab.id === id ? { ...tab, ...patch } : tab))
  }

  const changeTransaction = async (tab: QueryTab, action: 'begin' | 'commit' | 'rollback'): Promise<void> => {
    if (!canExecute() || runningQueries.current.has(tab.id)) return
    if (action === 'begin' && dirtyTabs.current.has(tab.id)) {
      patchTransaction(tab.id, { transactionMessage: 'Save or discard pending result edits before starting a transaction.' })
      return
    }
    runningQueries.current.add(tab.id)
    patchTransaction(tab.id, { transactionBusy: true, transactionMessage: undefined })
    try {
      const result = await window.api.editorTransaction(tab.id, action)
      if (result.ok) {
        patchTransaction(tab.id, {
          transaction: result.value,
          transactionMessage: action === 'commit' ? 'Transaction committed.' : action === 'rollback' ? 'Transaction rolled back.' : undefined
        })
        if (action !== 'begin') void refreshSchema()
      } else {
        const status = await window.api.editorTransaction(tab.id, 'status')
        patchTransaction(tab.id, { transaction: status.ok ? status.value : tab.transaction, transactionMessage: result.error })
      }
    } catch (error) {
      patchTransaction(tab.id, { transactionMessage: error instanceof Error ? error.message : String(error) })
    } finally {
      runningQueries.current.delete(tab.id)
      patchTransaction(tab.id, { transactionBusy: false })
    }
  }

  const useSchema = async (name: string): Promise<void> => {
    if (!conn?.info.capabilities.switchSchema || !canExecute() || runningQueries.current.size || hasOpenTransaction || name === currentDb) return
    setSwitchingDatabase(true)
    setDatabaseError(null)
    try {
      const r = await window.api.useSchema(name)
      if (r.ok) {
        defaultSchema.current = name
        querySchemas.current.clear()
        updateDb(name)
      }
      else setDatabaseError(r.error)
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : String(error))
    } finally {
      setSwitchingDatabase(false)
    }
  }

  const insertText = (text: string): void => {
    const editor = editors.current.get(lastQueryId.current)
    const sel = editor?.getSelection()
    if (!editor || !sel) return
    setActiveId(lastQueryId.current)
    editor.executeEdits('schema-tree', [{ range: sel, text, forceMoveMarkers: true }])
    requestAnimationFrame(() => editor.focus())
  }

  /**
   * Opens a table tab. With `filters` (following a foreign key) it gets its own tab keyed by the
   * filter, so the same reference reuses its tab. Stable (only uses state setters): it feeds
   * memoized grid props, and a new function per render would make the grids re-push forever.
   */
  const openTable = useCallback((schema: string, table: string, view: TableViewMode, filters?: RowFilter[]): void => {
    const key = `${schema}.${table}`
    setRecentTables((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)].slice(0, MAX_RECENT)
      try {
        localStorage.setItem(RECENT_TABLES_KEY, JSON.stringify(next))
      } catch {
        /* not persisted; fine */
      }
      return next
    })
    const id = `table:${key}` + (filters?.length ? `?${filters.map((f) => `${f.column}${f.op}${f.value}`).join('&')}` : '')
    setTabs((ts) =>
      ts.some((t) => t.id === id)
        ? ts.map((t) => (t.id === id && t.kind === 'table' ? { ...t, view } : t))
        : [...ts, { id, kind: 'table', schema, table, view, filters }]
    )
    setActiveId(id)
  }, [])
  const openReference = useCallback(
    (schema: string, table: string, filters: RowFilter[]) => openTable(schema, table, 'data', filters),
    [openTable]
  )

  const focusActiveTabLabel = (): void => {
    requestAnimationFrame(() => tabbar.current?.querySelector<HTMLButtonElement>('.tab.active .tab-label')?.focus())
  }

  const activateTab = (tab: Tab): void => {
    setActiveId(tab.id)
    if (tab.kind === 'query') {
      lastQueryId.current = tab.id
      showQuerySchema(tab.id)
      requestAnimationFrame(() => editors.current.get(tab.id)?.focus())
    }
  }

  const newQueryTab = (initialSql?: string, savedQueryId?: string): string => {
    const number = nextQueryNumber.current++
    const tab: QueryTab = { id: `query:${number}`, kind: 'query', number, run: { status: 'idle' }, sql: initialSql ?? '', selectOnMount: !!initialSql, savedQueryId }
    setTabs((ts) => [...ts, tab])
    activateTab(tab)
    return tab.id
  }

  const openSavedQuery = (query: SavedQuery): void => {
    const tab = tabs.find((item) => item.kind === 'query' && item.savedQueryId === query.id)
    if (tab) activateTab(tab)
    else newQueryTab(query.sql, query.id)
  }

  const openInEditor = (sql: string): void => {
    const text = sql.trimEnd()
    if (text) newQueryTab(text.endsWith(';') ? text : `${text};`)
  }

  const openProcedureMenu = async (schema: string, name: string): Promise<void> => {
    const generation = connectionGeneration.current
    const key = procedureKey(schema, name)
    const favourite = favourites.has(key)
    const menu = await window.api.explorerMenu('procedure', { favourite, canChange: false })
    if (generation !== connectionGeneration.current) return
    if (!menu.ok) {
      setProcedureError(menu.error)
      return
    }
    if (menu.value === 'toggle-favourite') {
      await updateFavourite(key, !favourite)
      return
    }
    if (menu.value !== 'procedure-create' && menu.value !== 'procedure-exec') return

    setProcedureError(null)
    const result = menu.value === 'procedure-create'
      ? await window.api.procedureDefinition(schema, name)
      : await window.api.procedureCall(schema, name)
    if (generation !== connectionGeneration.current) return
    if (result.ok) newQueryTab(result.value)
    else setProcedureError(result.error)
  }

  const closeTab = (id: string): void => {
    if (id === FIRST_QUERY.id || runningQueries.current.has(id)) return
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return
    const name = tab.kind === 'table' ? tab.table : `Query ${tab.number} results`
    if (dirtyTabs.current.has(id) && !window.confirm(`Discard unsaved changes to ${name}?`)) return
    if (tab.kind === 'query' && tab.transaction && !window.confirm('Roll back the transaction and close this tab?')) return
    dirtyTabs.current.delete(id)
    recentTabIds.current = recentTabIds.current.filter((recent) => recent !== id)
    editors.current.delete(id)
    if (tab.kind === 'query') {
      querySchemas.current.delete(id)
      void window.api.closeQueryTab(id)
    }
    const next = tabs.filter((t) => t.id !== id)
    if (lastQueryId.current === id) {
      lastQueryId.current = recentTabIds.current.find((recent) => next.some((t) => t.id === recent && t.kind === 'query')) ?? FIRST_QUERY.id
      showQuerySchema(lastQueryId.current)
    }
    setTabs(next)
    if (id === activeId) {
      const previousId = recentTabIds.current.find((recent) => next.some((t) => t.id === recent))
      const target = next.find((t) => t.id === (previousId ?? lastQueryId.current)) ?? FIRST_QUERY
      activateTab(target)
      if (target.kind === 'table') focusActiveTabLabel()
    }
  }

  const setTableView = (id: string, view: TableViewMode): void =>
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === 'table' ? { ...t, view } : t)))

  const moveTab = (id: string, targetId: string, after: boolean): void => {
    if (id === targetId) return
    setTabs((ts) => {
      const moved = ts.find((tab) => tab.id === id)
      const remaining = ts.filter((tab) => tab.id !== id)
      const target = remaining.findIndex((tab) => tab.id === targetId)
      if (!moved || target < 0) return ts
      remaining.splice(target + Number(after), 0, moved)
      return remaining
    })
  }

  const startTabDrag = (e: PointerEvent<HTMLButtonElement>, from: number): void => {
    if (e.button !== 0 || !e.isPrimary) return
    suppressTabClick.current = false
    const bar = tabbar.current
    if (!bar || tabs.length < 2) return
    const bounds = Array.from(bar.querySelectorAll<HTMLElement>('.tab'), (element, index) => ({
      id: tabs[index].id,
      left: element.offsetLeft,
      width: element.offsetWidth
    }))
    tabDrag.current = { pointerId: e.pointerId, from, startX: e.clientX, startScroll: bar.scrollLeft, bounds, to: from, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const previewTabDrag = (e: PointerEvent<HTMLButtonElement>): void => {
    const drag = tabDrag.current
    const bar = tabbar.current
    if (!drag || drag.pointerId !== e.pointerId || !bar) return
    const dx = e.clientX - drag.startX + bar.scrollLeft - drag.startScroll
    if (!drag.moved && Math.abs(dx) < 5) return
    drag.moved = true
    suppressTabClick.current = true

    const source = drag.bounds[drag.from]
    const first = drag.bounds[0]
    const last = drag.bounds[drag.bounds.length - 1]
    const gap = drag.bounds[1].left - first.left - first.width
    const left = Math.max(first.left, Math.min(source.left + dx, last.left + last.width - source.width))
    drag.to = drag.bounds.filter((bounds, index) => {
      const center = bounds.left + bounds.width / 2
      return index < drag.from ? left >= center : index > drag.from && left + source.width >= center
    }).length
    const target = drag.bounds[drag.to]
    const slotLeft = drag.to > drag.from ? target.left + target.width - source.width : target.left
    setTabDrop({
      from: drag.from,
      to: drag.to,
      width: source.width,
      shift: source.width + gap,
      offset: left - source.left,
      slotLeft
    })
  }

  const finishTabDrag = (e: PointerEvent<HTMLButtonElement>): void => {
    const drag = tabDrag.current
    if (!drag || drag.pointerId !== e.pointerId) return
    tabDrag.current = null
    setTabDrop(null)
    if (e.type === 'pointerup' && drag.moved) {
      moveTab(drag.bounds[drag.from].id, drag.bounds[drag.to].id, drag.to > drag.from)
    }
  }

  const activeTab = tabs.find((t) => t.id === activeId) ?? FIRST_QUERY
  const queryRunning = tabs.some((t) => t.kind === 'query' && (t.run.status === 'running' || t.transactionBusy))
  const hasOpenTransaction = tabs.some((t) => t.kind === 'query' && t.transaction)

  const scopedActions = useRef(new Map<MenuCommand, (command: MenuCommand) => void>())
  const [scopedCommands, setScopedCommands] = useState<MenuCommand[]>([])
  const registerMenuAction = useCallback<RegisterMenuAction>((commands, run) => {
    for (const command of commands) scopedActions.current.set(command, run)
    setScopedCommands([...scopedActions.current.keys()])
    return () => {
      for (const command of commands) {
        if (scopedActions.current.get(command) === run) scopedActions.current.delete(command)
      }
      setScopedCommands([...scopedActions.current.keys()])
    }
  }, [])

  // MySQL exposes databases as schemas. The other drivers already introspect
  // only the connected database, including all of its schemas.
  const canSwitchDatabase = conn?.info.driver === 'mysql' && conn.info.capabilities.switchSchema
  const visibleSchemas = canSwitchDatabase ? schemas.filter((schema) => schema.name === currentDb) : schemas
  const databaseNames = canSwitchDatabase ? schemas.map((schema) => schema.name) : undefined
  const workspaceReady = connected && !disconnecting && !switchingDatabase
  const workspaceInteractive = workspaceReady && !paletteOpen && !designer && sqlToSave === null
  const canChangeSchema = workspaceInteractive && !queryRunning && !conn?.readOnly

  const newTable = (schema?: string): void => {
    const target = schema ?? (schemas.some((item) => item.name === currentDb) ? currentDb : schemas[0]?.name)
    if (target) setDesigner({ kind: 'create', schema: target })
  }

  const updateFavourite = async (key: string, favourite: boolean): Promise<void> => {
    if (!conn) return
    const generation = connectionGeneration.current
    const result = await window.api.setFavourite(conn.storageIdentity, key, favourite)
    if (generation !== connectionGeneration.current) return
    if (result.ok) setFavourites(new Set(result.value))
    setExplorerStorageError(result.ok ? null : `Could not save favourites. ${result.error}`)
  }

  const openExplorerMenu = async (schema: string, table?: string, baseTable = false): Promise<void> => {
    const generation = connectionGeneration.current
    const key = table === undefined ? undefined : tableKey(schema, table)
    const result = key === undefined
      ? await window.api.explorerMenu('schema')
      : await window.api.explorerMenu('table', { favourite: favourites.has(key), canChange: baseTable && canChangeSchema })
    if (generation !== connectionGeneration.current || !result.ok || !result.value) return
    if (result.value === 'toggle-favourite' && key !== undefined) {
      await updateFavourite(key, !favourites.has(key))
      return
    }
    if (runningQueries.current.size) return
    if (result.value === 'new') newTable(schema)
    else if (table !== undefined && (result.value === 'edit' || result.value === 'drop' || result.value === 'truncate')) {
      setDesigner({ kind: result.value, schema, table })
    }
  }

  const applyTableAction = async (action: TableAction): Promise<string | null> => {
    const { schema, table } = action
    const matches = (tab: Tab): tab is Extract<Tab, { kind: 'table' }> => tab.kind === 'table' && tab.schema === schema && tab.table === table
    if (tabs.some((tab) => matches(tab) && dirtyTabs.current.has(tab.id))) {
      return 'Save or discard pending row edits in this table before changing it.'
    }
    const result = await window.api.changeTable(action)
    if (!result.ok) return result.error

    if (action.kind === 'drop') {
      const key = tableKey(schema, table)
      if (favourites.has(key)) await updateFavourite(key, false)
      setTabs((current) => current.filter((tab) => !matches(tab)))
      if (matches(activeTab)) setActiveId(lastQueryId.current)
    } else if (action.kind === 'create') {
      openTable(schema, table, 'schema')
    } else {
      if (action.kind === 'renameColumn' || action.kind === 'dropColumn') {
        const updateFilters = (filters: RowFilter[]): RowFilter[] => filters.flatMap((filter) => {
          if (filter.column !== action.column) return [filter]
          return action.kind === 'renameColumn' ? [{ ...filter, column: action.name }] : []
        })
        setTabs((current) => current.map((tab) => matches(tab) ? {
          ...tab,
          filters: tab.filters && updateFilters(tab.filters),
          applied: tab.applied && { ...tab.applied, filters: updateFilters(tab.applied.filters) }
        } : tab))
      }
      setTableVersions((versions) => ({ ...versions, [tableKey(schema, table)]: (versions[tableKey(schema, table)] ?? 0) + 1 }))
    }
    await refreshSchema()
    setDesigner(null)
    return null
  }
  const menuScope = workspaceInteractive ? registerMenuAction : null
  const activeQueryRunning = activeTab.kind === 'query' && activeTab.run.status === 'running'
  const activeTransaction = activeTab.kind === 'query' ? activeTab.transaction : null
  const transactionMessage = activeTab.kind === 'query' ? activeTab.transactionMessage : undefined
  const canControlTransaction = workspaceInteractive && !activeQueryRunning && activeTab.kind === 'query' && !activeTab.transactionBusy
  const canRun = canControlTransaction && !activeTransaction?.rollbackOnly
  const canDisconnect = workspaceInteractive && !queryRunning
  const queryEditor = workspaceInteractive && activeTab.kind === 'query'
  const activeSavedQueryId = activeTab.kind === 'query' ? activeTab.savedQueryId : undefined
  const queryName = (tab: QueryTab): string =>
    savedQueries.find((query) => query.id === tab.savedQueryId)?.name ?? `Query ${tab.number}`
  const saveActiveQuery = queryEditor && activeTab.kind === 'query' && activeTab.sql.trim()
    ? () => setSqlToSave({
      tabId: activeTab.id,
      sql: editors.current.get(activeTab.id)?.getValue() ?? activeTab.sql,
      savedQuery: savedQueries.find((query) => query.id === activeSavedQueryId)
    })
    : undefined

  const removeSavedQuery = async (query: SavedQuery): Promise<void> => {
    if (!conn || !window.confirm(`Delete saved query “${query.name}”?`)) return
    const generation = connectionGeneration.current
    const result = await window.api.deleteSavedQuery(conn.storageIdentity, query.id)
    if (generation !== connectionGeneration.current) return
    if (!result.ok) {
      setExplorerStorageError(`Could not delete the saved query. ${result.error}`)
      return
    }
    setSavedQueries(result.value)
    setExplorerStorageError(null)
    setTabs((current) => current.map((tab) => tab.kind === 'query' && tab.savedQueryId === query.id
      ? { ...tab, savedQueryId: undefined } : tab))
  }
  const toggleComment = (action: 'editor.action.commentLine' | 'editor.action.blockComment'): void => {
    const editor = editors.current.get(activeTab.id)
    editor?.focus()
    void editor?.getAction(action)?.run()
  }
  const workspaceCommands: Partial<Record<MenuCommand, () => void>> = {
    connect: !connected ? () => document.querySelector<HTMLButtonElement>('.connection-sidebar button[aria-current="true"]')?.focus() : undefined,
    disconnect: canDisconnect ? () => void disconnect() : undefined,
    'new-query': workspaceInteractive ? () => newQueryTab() : undefined,
    'save-query': saveActiveQuery,
    'close-tab': workspaceInteractive && activeTab.id !== FIRST_QUERY.id &&
      !(activeTab.kind === 'query' && activeTab.run.status === 'running') ? () => closeTab(activeTab.id) : undefined,
    'refresh-schema': workspaceInteractive ? () => void refreshSchema() : undefined,
    'run-query': canRun ? () => void execute(activeTab.id) : undefined,
    'cancel-query': activeQueryRunning ? () => void window.api.cancel(activeTab.id) : undefined,
    'toggle-line-comment': queryEditor ? () => toggleComment('editor.action.commentLine') : undefined,
    'toggle-block-comment': queryEditor ? () => toggleComment('editor.action.blockComment') : undefined,
    'find-table': workspaceReady && !designer && sqlToSave === null ? () => {
      if (paletteOpen) closePalette()
      else {
        focusBeforePalette.current = document.activeElement
        setPaletteOpen(true)
      }
    } : undefined,
    'toggle-inspector': workspaceInteractive ? () => setInspectorOpen((open) => !open) : undefined
  }

  const menuDispatch = useRef<(command: MenuCommand) => void>(() => {})
  menuDispatch.current = (command) => {
    const run = workspaceCommands[command]
    if (run) run()
    else if (workspaceInteractive) scopedActions.current.get(command)?.(command)
  }
  useEffect(() => window.api.onMenuCommand((command) => menuDispatch.current(command)), [])

  useEffect(() => {
    if (!workspaceInteractive) {
      tabCycle.current = null
      return
    }
    const inQuery = activeTab.kind === 'query'
    const inTableData = activeTab.kind === 'table' && activeTab.view === 'data'
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        if (tabs.length < 2) return
        // Keep the order fixed until Ctrl is released so consecutive presses can reach every tab.
        const order = tabCycle.current ??= [...new Set([activeTab.id, ...recentTabIds.current, ...tabs.map((tab) => tab.id)])]
        const available = order.filter((id) => tabs.some((tab) => tab.id === id))
        const index = available.indexOf(activeTab.id)
        const step = event.shiftKey ? -1 : 1
        const next = tabs.find((tab) => tab.id === available[(index + step + available.length) % available.length])
        if (next) {
          activateTab(next)
          if (next.kind === 'table') focusActiveTabLabel()
        }
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) menuDispatch.current('new-query')
        return
      }
      if (!inQuery && !inTableData) return
      // On layouts such as Finnish, typing "/" requires Shift.
      const comment = inQuery && (event.ctrlKey || event.metaKey) && !event.altKey &&
        event.key === '/' && editors.current.get(activeTab.id)?.hasTextFocus()
      if (comment) {
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) menuDispatch.current('toggle-line-comment')
        return
      }
      if (event.altKey || event.shiftKey) return
      const f5 = event.key === 'F5' && !event.ctrlKey && !event.metaKey
      const refresh = inTableData && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r'
      if (!f5 && !refresh) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) menuDispatch.current(inQuery ? 'run-query' : 'refresh-table-data')
    }
    const resetCycle = (): void => { tabCycle.current = null }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!event.ctrlKey) resetCycle()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', resetCycle)
    window.addEventListener('pointerdown', resetCycle, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', resetCycle)
      window.removeEventListener('pointerdown', resetCycle, true)
    }
  }, [workspaceInteractive, activeTab, tabs])

  const sentMenuAvailability = useRef('')
  useEffect(() => {
    const commands = (Object.keys(workspaceCommands) as MenuCommand[]).filter((command) => workspaceCommands[command])
    if (workspaceInteractive) commands.push(...scopedCommands)
    const signature = commands.join(',')
    if (sentMenuAvailability.current === signature) return
    sentMenuAvailability.current = signature
    window.api.setMenuAvailability(commands)
  })

  return (
    <InspectorContext.Provider value={inspectorApi}>
      <div className={`app ${inspectorOpen ? 'with-inspector' : ''}`} data-connection-color={conn?.color}>
        <header className="toolbar">
          <button onClick={() => newQueryTab()} disabled={!conn || disconnecting}>+ New query</button>
          {activeTab.kind === 'query' && conn && <button onClick={saveActiveQuery} disabled={!saveActiveQuery}>Save query…</button>}
          <button
            className="primary"
            onClick={() => void execute(activeTab.id)}
            disabled={!canRun}
            title="Ctrl+Enter"
          >
            ▶ Run
          </button>
          <button onClick={() => void window.api.cancel(activeTab.id)} disabled={!activeQueryRunning}>
            ■ Cancel
          </button>
          {activeTab.kind === 'query' && conn && !activeTransaction && (
            <button
              type="button"
              disabled={!canControlTransaction}
              onClick={() => void changeTransaction(activeTab, 'begin')}
            >
              Manual transaction
            </button>
          )}
          {activeTransaction && activeTab.kind === 'query' && (
            <div className="transaction-actions" role="group" aria-label="Editor transaction">
              <button className="transaction-commit" type="button" disabled={!canControlTransaction || activeTransaction.rollbackOnly} onClick={() => void changeTransaction(activeTab, 'commit')}>Commit</button>
              <button className="transaction-rollback" type="button" disabled={!canControlTransaction} onClick={() => void changeTransaction(activeTab, 'rollback')}>Rollback</button>
              <span className="muted">
                {activeTransaction.statements} {activeTransaction.statements === 1 ? 'statement' : 'statements'}
                {activeTransaction.rollbackOnly ? ' · Rollback required' : ''}
              </span>
            </div>
          )}
          <div className="spacer" />
          <button
            aria-pressed={inspectorOpen}
            className={inspectorOpen ? 'active-toggle' : ''}
            onClick={() => setInspectorOpen((o) => !o)}
            title="Show the selected cell's value in a side panel (Ctrl+I)"
          >
            ◧ Inspector
          </button>
        </header>

        <aside className="sidebar" aria-label="Database explorer">
          <SchemaTree
            key={conn?.label ?? 'none'}
            activeTable={activeTab.kind === 'table' ? activeTab : undefined}
            schemas={visibleSchemas}
            currentDb={currentDb}
            databaseNames={databaseNames}
            databaseError={databaseError}
            onUseDatabase={workspaceInteractive && !queryRunning && !hasOpenTransaction && conn?.info.capabilities.switchSchema ? useSchema : undefined}
            onInsert={insertText}
            onOpenTable={openTable}
            onProcedureMenu={workspaceInteractive ? openProcedureMenu : undefined}
            procedureError={procedureError}
            onNewTable={canChangeSchema && visibleSchemas.length > 0 ? newTable : undefined}
            favourites={favourites}
            savedQueries={conn ? savedQueries : []}
            explorerStorageError={conn ? explorerStorageError : null}
            activeSavedQueryId={activeSavedQueryId}
            onOpenSavedQuery={openSavedQuery}
            onRemoveSavedQuery={removeSavedQuery}
            onSchemaContextMenu={canChangeSchema ? openExplorerMenu : undefined}
            onTableContextMenu={workspaceInteractive ? openExplorerMenu : undefined}
            onRefresh={workspaceInteractive ? refreshSchema : undefined}
            onDisconnect={canDisconnect ? disconnect : undefined}
          />
        </aside>

        <main>
          <nav className="tabbar" ref={tabbar} aria-label="Workspace tabs">
            {tabDrop && <div className="tab-drop-slot" style={{ left: tabDrop.slotLeft, width: tabDrop.width }} aria-hidden="true" />}
            {tabs.map((t, index) => (
              <div
                key={t.id}
                className={`tab ${t.id === activeId ? 'active' : ''}${tabDrop?.from === index ? ' dragging' : ''}`}
                style={tabDrop ? { transform: `translateX(${tabDragOffset(tabDrop, index)}px)` } : undefined}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              >
                <button
                  className="tab-label"
                  aria-current={t.id === activeId ? 'page' : undefined}
                  aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                  onClick={(e) => {
                    if (!suppressTabClick.current || e.detail === 0) activateTab(t)
                    suppressTabClick.current = false
                  }}
                  onPointerDown={(e) => startTabDrag(e, index)}
                  onPointerMove={previewTabDrag}
                  onPointerUp={finishTabDrag}
                  onPointerCancel={finishTabDrag}
                  onLostPointerCapture={finishTabDrag}
                  onKeyDown={(e) => {
                    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                    e.preventDefault()
                    const right = e.key === 'ArrowRight'
                    const target = tabs[index + (right ? 1 : -1)]
                    if (!target) return
                    const label = e.currentTarget
                    moveTab(t.id, target.id, right)
                    requestAnimationFrame(() => {
                      label.focus()
                      label.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                    })
                  }}
                  title={
                    t.kind === 'table'
                      ? `${t.schema}.${t.table}${t.filters?.length ? ` where ${filterSummary(t.filters)}` : ''}`
                      : queryName(t)
                  }
                >
                  {t.kind === 'query' ? (
                    `✎ ${queryName(t)}${t.run.status === 'running' ? ' …' : ''}`
                  ) : (
                    <>
                      {t.view === 'schema' ? 'ⓘ' : '▦'} {t.table}
                      {t.filters?.length ? <span className="tab-filter"> {filterSummary(t.filters)}</span> : null}
                    </>
                  )}
                </button>
                {t.id !== FIRST_QUERY.id && (
                  <button
                    className="tab-close"
                    aria-label={t.kind === 'query' ? `Close ${queryName(t)}` : `Close ${t.table}`}
                    disabled={t.kind === 'query' && t.run.status === 'running'}
                    onClick={() => closeTab(t.id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </nav>

          {/* Keep buffers, results, filters and pages mounted while switching tabs. */}
          {tabs.map((t) => t.kind === 'query' && (
            <QuerySplit
              key={t.id}
              hidden={t.id !== activeId}
              share={t.split ?? 45}
              onResize={(split) => setTabs((ts) => ts.map((tab) =>
                tab.kind === 'query' && tab.id === t.id ? { ...tab, split } : tab
              ))}
              editor={
                <SqlEditor
                  initialSql={t.sql}
                  selectOnMount={t.selectOnMount}
                  onChange={(sql) => setTabs((ts) => ts.map((tab) =>
                    tab.kind === 'query' && tab.id === t.id ? { ...tab, sql } : tab
                  ))}
                  onMount={(editor) => editors.current.set(t.id, editor)}
                  onRun={(statementOnly) => execute(t.id, statementOnly)}
                  runDisabled={!workspaceInteractive || t.run.status === 'running' || !!t.transactionBusy || !!t.transaction?.rollbackOnly}
                />
              }
              results={
                <MenuActionsContext.Provider value={t.id === activeId ? menuScope : null}>
                  <ResultsPanel
                    run={t.run}
                    readOnly={!!t.transaction}
                    label={queryName(t)}
                    onRerun={(sql, notice) => void runSql(t.id, sql, notice)}
                    onDirtyChange={(dirty) => {
                      if (dirty) dirtyTabs.current.add(t.id)
                      else dirtyTabs.current.delete(t.id)
                    }}
                    onOpenSql={openInEditor}
                  />
                </MenuActionsContext.Provider>
              }
            />
          ))}
          {tabs.map(
            (t) =>
              t.kind === 'table' && (
                <div key={t.id} className="tab-panel" hidden={t.id !== activeId}>
                  <MenuActionsContext.Provider value={t.id === activeId ? menuScope : null}>
                    <TableView
                      key={tableVersions[tableKey(t.schema, t.table)] ?? 0}
                      onEditSchema={canChangeSchema ? () => setDesigner({ kind: 'edit', schema: t.schema, table: t.table }) : undefined}
                      sqlite={conn?.info.driver === 'sqlite'}
                      schema={t.schema}
                      table={t.table}
                      view={t.view}
                      onViewChange={(v) => setTableView(t.id, v)}
                      onOpenSql={openInEditor}
                      initialFilter={t.applied ?? (t.filters ? { filters: t.filters, match: 'all' } : undefined)}
                      onFilterApply={(applied) => setTabs((ts) => ts.map((tab) =>
                        tab.kind === 'table' && tab.id === t.id ? { ...tab, applied } : tab
                      ))}
                      onOpenReference={openReference}
                      onDirtyChange={(dirty) => {
                        if (dirty) dirtyTabs.current.add(t.id)
                        else dirtyTabs.current.delete(t.id)
                      }}
                    />
                  </MenuActionsContext.Provider>
                </div>
              )
          )}
        </main>

        {inspectorOpen && (
          <ValueInspector item={inspected} onClose={() => setInspectorOpen(false)} width={inspectorWidth} onResize={resizeInspector} />
        )}

        <footer className="statusbar">
          <div className="workspace-status">
            {activeTab.kind === 'query' ? <StatusText run={activeTab.run} /> : <span>{activeTab.schema}.{activeTab.table}</span>}
          </div>
          {transactionMessage && <span className="workspace-status" role="status" title={transactionMessage}>{transactionMessage}</span>}
          {conn ? (
            <div className="conn-label" title={`${conn.label} · ${currentDb ?? 'No schema'} · ${DRIVER_LABELS[conn.info.driver]} ${conn.info.serverVersion}`}>
              <strong>{conn.label}</strong>
              <span className="conn-schema">{currentDb ?? 'No schema'}</span>
              <span className="conn-version">{DRIVER_LABELS[conn.info.driver]} {conn.info.serverVersion}</span>
            </div>
          ) : (
            <span>Disconnected</span>
          )}
        </footer>

        {!conn && <ConnectDialog onConnected={onConnected} />}
        {conn && sqlToSave !== null && (
          <SaveQueryDialog
            initialName={sqlToSave.savedQuery?.name}
            onClose={() => setSqlToSave(null)}
            onSave={async (name) => {
              const existing = sqlToSave.savedQuery
              const query = { id: existing?.id ?? crypto.randomUUID(), name, sql: sqlToSave.sql }
              const result = await window.api.saveQuery(conn.storageIdentity, query)
              if (!result.ok) return result.error
              setSavedQueries(result.value)
              setExplorerStorageError(null)
              setTabs((current) => current.map((tab) => tab.kind === 'query' && tab.id === sqlToSave.tabId
                ? { ...tab, savedQueryId: query.id } : tab))
              setSqlToSave(null)
              return null
            }}
          />
        )}
        {conn && designer && (
          <TableDesigner request={designer} schemas={schemas} driver={conn.info.driver} onClose={() => setDesigner(null)} onApply={applyTableAction} onOpenSql={openInEditor} />
        )}
        {conn && paletteOpen && (
          <TablePalette
            schemas={visibleSchemas}
            currentDb={currentDb}
            recent={recentTables}
            favourites={favourites}
            onClose={closePalette}
            onRunLookup={(sql) => {
              if (!canExecute()) return false
              setPaletteOpen(false)
              const id = newQueryTab(sql)
              void runSql(id, sql)
              return true
            }}
            onOpen={(schema, table, view) => {
              setPaletteOpen(false)
              openTable(schema, table, view)
            }}
          />
        )}
      </div>
    </InspectorContext.Provider>
  )
}

interface ResultsPanelProps {
  run: RunState
  readOnly: boolean
  label: string
  onRerun: (sql: string, notice: string) => void
  onDirtyChange: (dirty: boolean) => void
  onOpenSql: (sql: string) => void
}

function ResultsPanel({ run, readOnly, label, onRerun, onDirtyChange, onOpenSql }: ResultsPanelProps): JSX.Element {
  switch (run.status) {
    case 'idle':
      return <div className="placeholder">Run a query with Ctrl+Enter</div>
    case 'running':
      return <div className="placeholder">Running…</div>
    case 'error':
      return <pre className="error-panel">{run.error}</pre>
    case 'done':
      if (run.result.kind === 'rows') {
        return (
          <QueryResultsView
            key={run.id}
            sets={[run.result, ...(run.result.additionalResults ?? [])]}
            sql={run.sql}
            readOnly={readOnly || run.transactional}
            label={label}
            notice={run.notice}
            onRerun={(notice) => onRerun(run.sql, notice)}
            onDirtyChange={onDirtyChange}
            onOpenSql={onOpenSql}
          />
        )
      }
      return (
        <div className="placeholder">
          {run.result.affectedRows === null ? 'Statement completed' : `${run.result.affectedRows} row(s) affected`}
          {run.result.insertId !== null ? ` · insert id ${run.result.insertId}` : ''}
          {run.result.info ? ` · ${run.result.info}` : ''}
        </div>
      )
  }
}

function StatusText({ run }: { run: RunState }): JSX.Element {
  if (run.status === 'done' && run.result.kind === 'rows') {
    const r = run.result
    if (r.additionalResults?.length) return <span>{r.additionalResults.length + 1} result sets · {r.elapsedMs} ms</span>
    return (
      <span>
        {r.rowCount === null ? `${r.rows.length.toLocaleString()}+` : r.rowCount.toLocaleString()} rows · {r.elapsedMs} ms
        {r.truncated && (
          <span className="warn">
            {' '}
            · showing first {r.rows.length.toLocaleString()} rows{r.rowCount === null ? ' (more available)' : ''}
          </span>
        )}
      </span>
    )
  }
  if (run.status === 'done') return <span>{run.result.elapsedMs} ms</span>
  if (run.status === 'error') return <span className="warn">Query failed</span>
  if (run.status === 'running') return <span>Running…</span>
  return <span>Ready</span>
}
