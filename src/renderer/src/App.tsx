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
import { DRIVER_LABELS, type ConnectionConfig, type ConnectionInfo, type QueryResult, type RowFilter, type SchemaInfo } from '../../shared/types'
import { setEditorDialect } from './monacoSetup'

interface Connection {
  /** e.g. "dev@127.0.0.1:5432/shop" or "shop.sqlite" */
  label: string
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

type Tab =
  | { id: 'query'; kind: 'query' }
  | { id: string; kind: 'table'; schema: string; table: string; view: TableViewMode; filters?: RowFilter[] }

const filterSummary = (filters: RowFilter[]): string => filters.map((f) => `${f.column} = ${f.value}`).join(', ')

const QUERY_TAB: Tab = { id: 'query', kind: 'query' }

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
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [tabs, setTabs] = useState<Tab[]>([QUERY_TAB])
  const [activeId, setActiveId] = useState('query')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Tabs with unsaved row edits. Only read when closing, so a ref (no re-render) is enough.
  const dirtyTabs = useRef(new Set<string>())

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
    (cfg: ConnectionConfig, info: ConnectionInfo) => {
      setConn({ label: connectionLabel(cfg, info), info })
      setEditorDialect(info.driver)
      updateDb(info.schema)
      void refreshSchema()
    },
    [refreshSchema, updateDb]
  )

  const disconnect = async (): Promise<void> => {
    if (dirtyTabs.current.size > 0 && !window.confirm('Some tables have unsaved changes. Discard them and disconnect?')) return
    dirtyTabs.current.clear()
    await window.api.disconnect()
    setConn(null)
    setSchemas([])
    completionState.schemas = []
    setRun({ status: 'idle' })
    setTabs([QUERY_TAB])
    setActiveId('query')
    setInspected(null)
    setPaletteOpen(false)
  }

  const execute = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || run.status === 'running') return
    const sql = sqlToRun(editor)
    if (!sql) return
    setRun({ status: 'running', sql, startedAt: Date.now() })
    const r = await window.api.query(sql)
    if (!r.ok) {
      setRun({ status: 'error', sql, error: r.error })
      return
    }
    setRun({ status: 'done', sql, result: r.value.result })
    updateDb(r.value.schema)
    // DDL changes the schema; keep the tree and autocomplete in sync.
    if (/^\s*(create|alter|drop|rename|truncate)\b/i.test(sql)) void refreshSchema()
  }, [run.status, refreshSchema, updateDb])

  const useSchema = async (name: string): Promise<void> => {
    if (!conn?.info.capabilities.switchSchema) return
    const r = await window.api.useSchema(name)
    if (r.ok) updateDb(name)
  }

  const insertText = (text: string): void => {
    const editor = editorRef.current
    const sel = editor?.getSelection()
    if (!editor || !sel) return
    setActiveId('query')
    editor.executeEdits('schema-tree', [{ range: sel, text, forceMoveMarkers: true }])
    editor.focus()
  }

  /** Appends SQL to the end of the query editor, selects it and switches to the Query tab. */
  const openInEditor = (sql: string): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    setActiveId('query')
    const end = model.getFullModelRange().getEndPosition()
    const prefix = model.getValueLength() === 0 ? '' : model.getLineContent(end.lineNumber).trim() ? '\n\n' : '\n'
    const text = sql.trimEnd().endsWith(';') ? sql.trimEnd() : `${sql.trimEnd()};`
    editor.executeEdits('open-in-editor', [{ range: monaco.Range.fromPositions(end), text: prefix + text, forceMoveMarkers: true }])
    const startPos = model.getPositionAt(model.getOffsetAt(end) + prefix.length)
    const endPos = model.getFullModelRange().getEndPosition()
    editor.setSelection(monaco.Range.fromPositions(startPos, endPos))
    editor.revealRangeInCenter(editor.getSelection()!)
    // The editor was hidden; focus once it's visible again.
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

  const closeTab = (id: string): void => {
    if (id === 'query') return
    const tab = tabs.find((t) => t.id === id)
    if (dirtyTabs.current.has(id) && tab?.kind === 'table' && !window.confirm(`Discard unsaved changes to ${tab.table}?`)) return
    dirtyTabs.current.delete(id)
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id)
  }

  const setTableView = (id: string, view: TableViewMode): void =>
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === 'table' ? { ...t, view } : t)))

  const activeTab = tabs.find((t) => t.id === activeId) ?? QUERY_TAB
  const queryActive = activeTab.kind === 'query'

  return (
    <InspectorContext.Provider value={inspectorApi}>
      <div className={`app ${inspectorOpen ? 'with-inspector' : ''}`}>
        <header className="toolbar">
          <button className="primary" onClick={execute} disabled={!conn || !queryActive || run.status === 'running'} title="Ctrl+Enter">
            ▶ Run
          </button>
          <button onClick={() => void window.api.cancel()} disabled={run.status !== 'running'}>
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
              <button onClick={disconnect}>Disconnect</button>
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
          <nav className="tabbar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`tab ${t.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                title={
                  t.kind === 'table'
                    ? `${t.schema}.${t.table}${t.filters?.length ? ` where ${filterSummary(t.filters)}` : ''}`
                    : 'SQL editor'
                }
              >
                {t.kind === 'query' ? (
                  <span>✎ Query</span>
                ) : (
                  <>
                    <span>
                      {t.view === 'schema' ? 'ⓘ' : '▦'} {t.table}
                      {t.filters?.length ? <span className="tab-filter"> {filterSummary(t.filters)}</span> : null}
                    </span>
                    <button
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(t.id)
                      }}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}
          </nav>

          {/* Tabs stay mounted while hidden so the editor buffer, filters and pages survive switching. */}
          <div className="tab-panel query-panel" hidden={!queryActive}>
            <section className="editor">
              <SqlEditor onMount={(e) => (editorRef.current = e)} onRun={execute} />
            </section>
            <section className="results">
              <ResultsPanel run={run} />
            </section>
          </div>
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
          {queryActive ? <StatusText run={run} /> : <span>{activeTab.kind === 'table' && `${activeTab.schema}.${activeTab.table}`}</span>}
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

function ResultsPanel({ run }: { run: RunState }): JSX.Element {
  switch (run.status) {
    case 'idle':
      return <div className="placeholder">Run a query with Ctrl+Enter</div>
    case 'running':
      return <div className="placeholder">Running…</div>
    case 'error':
      return <pre className="error-panel">{run.error}</pre>
    case 'done':
      if (run.result.kind === 'rows') return <ResultsGrid fields={run.result.fields} rows={run.result.rows} sourceLabel="Query result" />
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
