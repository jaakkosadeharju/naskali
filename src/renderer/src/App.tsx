import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { monaco } from './monacoSetup'
import { completionState } from './completion'
import { ConnectDialog } from './components/ConnectDialog'
import { SchemaTree } from './components/SchemaTree'
import { SqlEditor, sqlToRun } from './components/SqlEditor'
import { ResultsGrid } from './components/ResultsGrid'
import { TableView, type TableViewMode } from './components/TableView'
import { ValueInspector } from './components/ValueInspector'
import { TablePalette } from './components/TablePalette'
import { InspectorContext, type InspectedValue, type InspectorApi } from './inspector'
import { DRIVER_LABELS, type ConnectionColor, type ConnectionConfig, type ConnectionInfo, type QueryResult, type RowFilter, type SchemaInfo } from '../../shared/types'
import { setEditorDialect } from './monacoSetup'

interface Connection {
  /** e.g. "dev@127.0.0.1:5432/shop" or "shop.sqlite" */
  label: string
  color: ConnectionColor
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
  | { status: 'done'; sql: string; result: QueryResult }
  | { status: 'error'; sql: string; error: string }

type QueryTab = { id: string; kind: 'query'; number: number; run: RunState; initialSql?: string }

type Tab =
  | QueryTab
  | { id: string; kind: 'table'; schema: string; table: string; view: TableViewMode; filters?: RowFilter[] }

const filterSummary = (filters: RowFilter[]): string => filters.map((f) => `${f.column} = ${f.value}`).join(', ')

const FIRST_QUERY: QueryTab = { id: 'query:1', kind: 'query', number: 1, run: { status: 'idle' } }

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
  const [schemas, setSchemas] = useState<SchemaInfo[]>([])
  const [tabs, setTabs] = useState<Tab[]>([FIRST_QUERY])
  const [activeId, setActiveId] = useState(FIRST_QUERY.id)
  const [disconnecting, setDisconnecting] = useState(false)
  const tabbar = useRef<HTMLElement>(null)
  const editors = useRef(new Map<string, monaco.editor.IStandaloneCodeEditor>())
  const nextQueryNumber = useRef(2)
  const lastQueryId = useRef(FIRST_QUERY.id)
  const runningQuery = useRef<string | null>(null)
  // Tabs with unsaved row edits. Only read when closing, so a ref (no re-render) is enough.
  const dirtyTabs = useRef(new Set<string>())

  useEffect(() => {
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
        if (!connected) return
        setPaletteOpen((open) => {
          if (!open) focusBeforePalette.current = document.activeElement
          return !open
        })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [connected])
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
    completionState.currentDb = db
  }, [])

  const refreshSchema = useCallback(async () => {
    const r = await window.api.introspect()
    if (r.ok) {
      setSchemas(r.value)
      completionState.schemas = r.value
    }
  }, [])

  const onConnected = useCallback(
    (cfg: ConnectionConfig, info: ConnectionInfo, color: ConnectionColor) => {
      setConn({ label: connectionLabel(cfg, info), color, info })
      setEditorDialect(info.driver)
      updateDb(info.schema)
      void refreshSchema()
    },
    [refreshSchema, updateDb]
  )

  const disconnect = async (): Promise<void> => {
    if (runningQuery.current || disconnecting) return
    if (dirtyTabs.current.size > 0 && !window.confirm('Some tables have unsaved changes. Discard them and disconnect?')) return
    setDisconnecting(true)
    await window.api.disconnect()
    dirtyTabs.current.clear()
    setConn(null)
    setSchemas([])
    completionState.schemas = []
    setTabs((ts) => ts.flatMap((t): QueryTab[] => t.kind === 'query' ? [{ ...t, run: { status: 'idle' } }] : []))
    setActiveId(lastQueryId.current)
    setInspected(null)
    setPaletteOpen(false)
    setDisconnecting(false)
  }

  const execute = async (id: string): Promise<void> => {
    const editor = editors.current.get(id)
    if (!conn || disconnecting || !editor || runningQuery.current) return
    const sql = sqlToRun(editor)
    if (!sql) return

    const setRun = (run: RunState): void => {
      setTabs((ts) => ts.map((t) => t.kind === 'query' && t.id === id ? { ...t, run } : t))
    }
    runningQuery.current = id
    setRun({ status: 'running', sql, startedAt: Date.now() })
    try {
      const r = await window.api.query(sql)
      if (!r.ok) {
        setRun({ status: 'error', sql, error: r.error })
        return
      }
      setRun({ status: 'done', sql, result: r.value.result })
      updateDb(r.value.schema)
      // DDL changes the schema; keep the tree and autocomplete in sync.
      if (/^\s*(create|alter|drop|rename|truncate)\b/i.test(sql)) void refreshSchema()
    } catch (error) {
      setRun({ status: 'error', sql, error: error instanceof Error ? error.message : String(error) })
    } finally {
      runningQuery.current = null
    }
  }

  const useSchema = async (name: string): Promise<void> => {
    if (!conn?.info.capabilities.switchSchema) return
    const r = await window.api.useSchema(name)
    if (r.ok) updateDb(name)
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

  const activateTab = (tab: Tab): void => {
    setActiveId(tab.id)
    if (tab.kind === 'query') {
      lastQueryId.current = tab.id
      requestAnimationFrame(() => editors.current.get(tab.id)?.focus())
    }
  }

  const newQueryTab = (initialSql?: string): void => {
    const number = nextQueryNumber.current++
    const tab: QueryTab = { id: `query:${number}`, kind: 'query', number, run: { status: 'idle' }, initialSql }
    setTabs((ts) => [...ts, tab])
    activateTab(tab)
  }

  const openInEditor = (sql: string): void => {
    const text = sql.trimEnd()
    if (text) newQueryTab(text.endsWith(';') ? text : `${text};`)
  }

  const closeTab = (id: string): void => {
    if (id === FIRST_QUERY.id || id === runningQuery.current) return
    const idx = tabs.findIndex((t) => t.id === id)
    const tab = tabs[idx]
    if (!tab) return
    if (dirtyTabs.current.has(id) && tab.kind === 'table' && !window.confirm(`Discard unsaved changes to ${tab.table}?`)) return
    dirtyTabs.current.delete(id)
    editors.current.delete(id)
    const next = tabs.filter((t) => t.id !== id)
    if (lastQueryId.current === id) {
      lastQueryId.current = next.slice(0, idx).reverse().find((t) => t.kind === 'query')?.id ?? FIRST_QUERY.id
    }
    setTabs(next)
    if (id === activeId) activateTab(next[Math.max(0, idx - 1)])
  }

  const setTableView = (id: string, view: TableViewMode): void =>
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === 'table' ? { ...t, view } : t)))

  const activeTab = tabs.find((t) => t.id === activeId) ?? FIRST_QUERY
  const queryRunning = tabs.some((t) => t.kind === 'query' && t.run.status === 'running')

  return (
    <InspectorContext.Provider value={inspectorApi}>
      <div className={`app ${inspectorOpen ? 'with-inspector' : ''}`} data-connection-color={conn?.color}>
        <header className="toolbar">
          <button onClick={() => newQueryTab()} disabled={!conn || disconnecting}>+ New query</button>
          <button
            className="primary"
            onClick={() => void execute(activeTab.id)}
            disabled={!conn || disconnecting || activeTab.kind !== 'query' || queryRunning}
            title="Ctrl+Enter"
          >
            ▶ Run
          </button>
          <button onClick={() => void window.api.cancel()} disabled={!queryRunning}>
            ■ Cancel
          </button>
          <div className="spacer" />
          <button
            className={inspectorOpen ? 'active-toggle' : ''}
            onClick={() => setInspectorOpen((o) => !o)}
            title="Show the selected cell's value in a side panel (Ctrl+I)"
          >
            ◧ Value
          </button>
          {conn && (
            <>
              <span className="conn-label">
                {conn.label} · {currentDb ?? 'no schema'} · {DRIVER_LABELS[conn.info.driver]} {conn.info.serverVersion}
              </span>
              <button onClick={disconnect} disabled={queryRunning || disconnecting}>Disconnect</button>
            </>
          )}
        </header>

        <aside className="sidebar">
          <SchemaTree
            key={conn?.label ?? 'none'}
            schemas={schemas}
            currentDb={currentDb}
            onUseDatabase={conn?.info.capabilities.switchSchema ? useSchema : undefined}
            onInsert={insertText}
            onOpenTable={openTable}
            onRefresh={refreshSchema}
          />
        </aside>

        <main className="main">
          <nav className="tabbar" ref={tabbar} aria-label="Workspace tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`tab ${t.id === activeId ? 'active' : ''}`}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              >
                <button
                  className="tab-label"
                  aria-current={t.id === activeId ? 'page' : undefined}
                  onClick={() => activateTab(t)}
                  title={
                    t.kind === 'table'
                      ? `${t.schema}.${t.table}${t.filters?.length ? ` where ${filterSummary(t.filters)}` : ''}`
                      : `SQL editor ${t.number}`
                  }
                >
                  {t.kind === 'query' ? (
                    `✎ Query ${t.number}${t.run.status === 'running' ? ' …' : ''}`
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
                    aria-label={t.kind === 'query' ? `Close Query ${t.number}` : `Close ${t.table}`}
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
            <div key={t.id} className="tab-panel query-panel" hidden={t.id !== activeId}>
              <section className="editor">
                <SqlEditor
                  primary={t.id === FIRST_QUERY.id}
                  initialSql={t.initialSql}
                  onMount={(editor) => editors.current.set(t.id, editor)}
                  onRun={() => void execute(t.id)}
                />
              </section>
              <section className="results">
                <ResultsPanel run={t.run} label={`Query ${t.number}`} />
              </section>
            </div>
          ))}
          {tabs.map(
            (t) =>
              t.kind === 'table' && (
                <div key={t.id} className="tab-panel" hidden={t.id !== activeId}>
                  <TableView
                    sqlite={conn?.info.driver === 'sqlite'}
                    schema={t.schema}
                    table={t.table}
                    view={t.view}
                    onViewChange={(v) => setTableView(t.id, v)}
                    onOpenSql={openInEditor}
                    initialFilters={t.filters}
                    onOpenReference={openReference}
                    onDirtyChange={(dirty) => {
                      if (dirty) dirtyTabs.current.add(t.id)
                      else dirtyTabs.current.delete(t.id)
                    }}
                  />
                </div>
              )
          )}
        </main>

        {inspectorOpen && (
          <ValueInspector item={inspected} onClose={() => setInspectorOpen(false)} width={inspectorWidth} onResize={resizeInspector} />
        )}

        <footer className="statusbar">
          {activeTab.kind === 'query' ? <StatusText run={activeTab.run} /> : <span>{activeTab.schema}.{activeTab.table}</span>}
        </footer>

        {!conn && <ConnectDialog onConnected={onConnected} />}
        {conn && paletteOpen && (
          <TablePalette
            schemas={schemas}
            currentDb={currentDb}
            recent={recentTables}
            onClose={closePalette}
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

function ResultsPanel({ run, label }: { run: RunState; label: string }): JSX.Element {
  switch (run.status) {
    case 'idle':
      return <div className="placeholder">Run a query with Ctrl+Enter</div>
    case 'running':
      return <div className="placeholder">Running…</div>
    case 'error':
      return <pre className="error-panel">{run.error}</pre>
    case 'done':
      if (run.result.kind === 'rows') return <ResultsGrid fields={run.result.fields} rows={run.result.rows} sourceLabel={label} />
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
