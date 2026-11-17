import { useCallback, useRef, useState } from 'react'
import { monaco } from './monacoSetup'
import { completionState } from './completion'
import { ConnectDialog } from './components/ConnectDialog'
import { SchemaTree } from './components/SchemaTree'
import { SqlEditor, sqlToRun } from './components/SqlEditor'
import { ResultsGrid } from './components/ResultsGrid'
import { TableView, type TableViewMode } from './components/TableView'
import type { ConnectionConfig, QueryResult, SchemaInfo } from '../../shared/types'

interface Connection {
  label: string
  serverVersion: string
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string; startedAt: number }
  | { status: 'done'; sql: string; result: QueryResult }
  | { status: 'error'; sql: string; error: string }

type Tab =
  | { id: 'query'; kind: 'query' }
  | { id: string; kind: 'table'; schema: string; table: string; view: TableViewMode }

const QUERY_TAB: Tab = { id: 'query', kind: 'query' }

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
    (cfg: ConnectionConfig, info: { serverVersion: string; database: string | null }) => {
      setConn({ label: `${cfg.user}@${cfg.host}:${cfg.port}`, serverVersion: info.serverVersion })
      updateDb(info.database)
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
    updateDb(r.value.database)
    // DDL changes the schema; keep the tree and autocomplete in sync.
    if (/^\s*(create|alter|drop|rename|truncate)\b/i.test(sql)) void refreshSchema()
  }, [run.status, refreshSchema, updateDb])

  const useDatabase = async (name: string): Promise<void> => {
    const r = await window.api.useDatabase(name)
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

  const openTable = (schema: string, table: string, view: TableViewMode): void => {
    const id = `table:${schema}.${table}`
    setTabs((ts) =>
      ts.some((t) => t.id === id)
        ? ts.map((t) => (t.id === id && t.kind === 'table' ? { ...t, view } : t))
        : [...ts, { id, kind: 'table', schema, table, view }]
    )
    setActiveId(id)
  }

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
    <div className="app">
      <header className="toolbar">
        <button className="primary" onClick={execute} disabled={!conn || !queryActive || run.status === 'running'} title="Ctrl+Enter">
          ▶ Run
        </button>
        <button onClick={() => void window.api.cancel()} disabled={run.status !== 'running'}>
          ■ Cancel
        </button>
        <div className="spacer" />
        {conn && (
          <>
            <span className="conn-label">
              {conn.label} · {currentDb ?? 'no database'} · MySQL {conn.serverVersion}
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
          onUseDatabase={useDatabase}
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
              title={t.kind === 'table' ? `${t.schema}.${t.table}` : 'SQL editor'}
            >
              {t.kind === 'query' ? (
                <span>✎ Query</span>
              ) : (
                <>
                  <span>
                    {t.view === 'schema' ? 'ⓘ' : '▦'} {t.table}
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
                  schema={t.schema}
                  table={t.table}
                  view={t.view}
                  onViewChange={(v) => setTableView(t.id, v)}
                  onOpenSql={openInEditor}
                  onDirtyChange={(dirty) => {
                    if (dirty) dirtyTabs.current.add(t.id)
                    else dirtyTabs.current.delete(t.id)
                  }}
                />
              </div>
            )
        )}
      </main>

      <footer className="statusbar">
        {queryActive ? <StatusText run={run} /> : <span>{activeTab.kind === 'table' && `${activeTab.schema}.${activeTab.table}`}</span>}
      </footer>

      {!conn && <ConnectDialog onConnected={onConnected} />}
    </div>
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
      if (run.result.kind === 'rows') return <ResultsGrid fields={run.result.fields} rows={run.result.rows} />
      return (
        <div className="placeholder">
          {run.result.affectedRows} row(s) affected
          {run.result.insertId ? ` · insert id ${run.result.insertId}` : ''}
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
        {r.rowCount.toLocaleString()} rows · {r.elapsedMs} ms
        {r.truncated && <span className="warn"> · showing first {r.rows.length.toLocaleString()} rows</span>}
      </span>
    )
  }
  if (run.status === 'done') return <span>{run.result.elapsedMs} ms</span>
  if (run.status === 'error') return <span className="warn">Query failed</span>
  if (run.status === 'running') return <span>Running…</span>
  return <span>Ready</span>
}
