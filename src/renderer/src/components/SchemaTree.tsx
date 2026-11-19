import { useEffect, useState } from 'react'
import type { SavedQuery, SchemaInfo } from '../../../shared/types'
import { procedureKey, tableKey } from '../workspaceStore'
import { MOD } from './TablePalette'

interface Props {
  activeTable?: { schema: string; table: string }
  schemas: SchemaInfo[]
  currentDb: string | null
  databaseNames?: string[]
  databaseError?: string | null
  /** Absent when the database can't switch schemas. */
  onUseDatabase?: (name: string) => void
  onInsert: (text: string) => void
  onOpenTable: (schema: string, table: string, view: 'data' | 'schema') => void
  onProcedureMenu?: (schema: string, name: string) => void
  procedureError?: string | null
  onNewTable?: (schema?: string) => void
  favourites: ReadonlySet<string>
  savedQueries: SavedQuery[]
  activeSavedQueryId?: string
  explorerStorageError?: string | null
  onOpenSavedQuery: (query: SavedQuery) => void
  onRemoveSavedQuery: (query: SavedQuery) => void
  onSchemaContextMenu?: (schema: string) => void
  onTableContextMenu?: (schema: string, table: string, baseTable: boolean) => void
  onRefresh?: () => void
  onDisconnect?: () => void
}

export function SchemaTree({ activeTable, schemas, currentDb, databaseNames, databaseError, onUseDatabase, onInsert, onOpenTable, onProcedureMenu, procedureError, onNewTable, favourites, savedQueries, activeSavedQueryId, explorerStorageError, onOpenSavedQuery, onRemoveSavedQuery, onSchemaContextMenu, onTableContextMenu, onRefresh, onDisconnect }: Props): JSX.Element {
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentDb ? [currentDb] : []))
  const [filter, setFilter] = useState('')
  const activeSchema = activeTable?.schema
  useEffect(() => {
    if (activeSchema) setOpen((current) => current.has(activeSchema) ? current : new Set(current).add(activeSchema))
  }, [activeSchema])
  const toggle = (key: string): void =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const f = filter.toLowerCase()
  const pinnedTables = schemas.flatMap((schema) => schema.tables
    .filter((table) => favourites.has(tableKey(schema.name, table.name)) && table.name.toLowerCase().includes(f))
    .map((table) => ({ schema: schema.name, table })))
  const pinnedProcedures = schemas.flatMap((schema) => (schema.procedures ?? [])
    .filter((name) => favourites.has(procedureKey(schema.name, name)) && name.toLowerCase().includes(f))
    .map((name) => ({ schema: schema.name, name })))

  const renderTable = (schema: string, t: SchemaInfo['tables'][number], shortcut = false): JSX.Element => {
    const id = tableKey(schema, t.name)
    const key = shortcut ? `favourite:${id}` : id
    const favourite = favourites.has(id)
    return (
      <li key={key}>
        <div
          className={`node table-node${activeTable?.schema === schema && activeTable.table === t.name ? ' selected' : ''}`}
          tabIndex={onTableContextMenu ? 0 : undefined}
          onContextMenu={onTableContextMenu ? (event) => {
            event.preventDefault()
            onTableContextMenu(schema, t.name, t.type === 'BASE TABLE')
          } : undefined}
          onDoubleClick={() => onOpenTable(schema, t.name, 'data')}
          title="Double-click to open data"
        >
          <button
            type="button"
            className="twisty table-twisty"
            aria-label={`${open.has(key) ? 'Collapse' : 'Expand'} columns for ${t.name}`}
            aria-expanded={open.has(key)}
            onClick={() => toggle(key)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {open.has(key) ? '▾' : '▸'}
          </button>
          <span className="table-label">
            {favourite ? <span className="table-favourite-star" role="img" aria-label="Favourite">★</span> : t.type === 'VIEW' ? '👁' : '▦'}{' '}
            {shortcut && !databaseNames ? `${schema}.${t.name}` : t.name}
          </span>
          <span className="node-actions" onDoubleClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              title="Open data"
              aria-label={`Open data for ${t.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onOpenTable(schema, t.name, 'data')
              }}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
                <path d="M2.5 6.5h11m-11 3h11m-7-3v6" />
              </svg>
            </button>
            <button
              type="button"
              title="Open schema"
              aria-label={`Open schema for ${t.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onOpenTable(schema, t.name, 'schema')
              }}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M6.5 4.5 3 8l3.5 3.5m3-7L13 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </span>
        </div>
        {open.has(key) && (
          <ul>
            {t.columns.map((c) => (
              <li key={c.name}>
                <div className="node column" onDoubleClick={() => onInsert(c.name)}>
                  <span className="col-name">
                    {c.key === 'PRI' ? '🔑 ' : ''}
                    {c.name}
                  </span>
                  <span className="muted">
                    {c.type}
                    {c.nullable ? '' : ' !'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </li>
    )
  }

  const renderProcedure = (schema: string, name: string, shortcut = false): JSX.Element => {
    const key = procedureKey(schema, name)
    return (
      <li key={key}>
        <button
          type="button"
          className="node procedure-node"
          title={`Actions for ${schema}.${name}`}
          aria-haspopup="menu"
          disabled={!onProcedureMenu}
          onClick={() => onProcedureMenu?.(schema, name)}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onProcedureMenu?.(schema, name)
          }}
        >
          <span className="routine-icon" aria-hidden="true">⚙</span>
          {favourites.has(key) && <span className="table-favourite-star" role="img" aria-label="Favourite">★ </span>}
          {shortcut && !databaseNames ? `${schema}.${name}` : name}
        </button>
      </li>
    )
  }

  return (
    <div className="schema-tree">
      <div className="tree-heading">
        <h2 className="pane-heading">Database explorer</h2>
        <div className="tree-actions">
          <button type="button" title="New table" aria-label="New table" onClick={() => onNewTable?.()} disabled={!onNewTable}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <button type="button" title="Refresh schema" aria-label="Refresh schema" onClick={onRefresh} disabled={!onRefresh}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 6a5 5 0 1 0-.4 5M13 2.5V6H9.5" />
            </svg>
          </button>
          <button type="button" title="Disconnect" aria-label="Disconnect" onClick={onDisconnect} disabled={!onDisconnect}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 2.5H3.5v11H7M6 8h7m-2.5-2.5L13 8l-2.5 2.5" />
            </svg>
          </button>
        </div>
      </div>
      {databaseNames && (
        <label className="tree-database">
          <span>Database</span>
          <select
            value={currentDb ?? ''}
            disabled={!onUseDatabase || databaseNames.length === 0}
            onChange={(event) => onUseDatabase?.(event.target.value)}
          >
            {!currentDb && <option value="" disabled>Select a database</option>}
            {currentDb && !databaseNames.includes(currentDb) && <option value={currentDb}>{currentDb}</option>}
            {databaseNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      )}
      {databaseError && <p className="procedure-error" role="alert">{databaseError}</p>}
      <div className="tree-filter">
        <input aria-label="Filter database objects" placeholder={`Filter (${MOD}P: open table)`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {procedureError && <p className="procedure-error" role="alert">{procedureError}</p>}
      {explorerStorageError && <p className="procedure-error" role="alert">{explorerStorageError}</p>}
      <ul className={databaseNames ? 'database-objects' : undefined}>
        {savedQueries.length > 0 && (
          <li>
            <div className="node tree-group-heading">Saved Queries</div>
            <ul>
              {savedQueries.map((query) => (
                <li key={query.id} className={`node table-node${query.id === activeSavedQueryId ? ' selected' : ''}`}>
                  <button
                    type="button"
                    className="table-label saved-query-link"
                    aria-current={query.id === activeSavedQueryId ? 'true' : undefined}
                    title={query.name}
                    onClick={() => onOpenSavedQuery(query)}
                  >
                    <span aria-hidden="true">✎ </span>{query.name}
                  </button>
                  <span className="node-actions">
                    <button type="button" title="Delete saved query" aria-label={`Delete saved query ${query.name}`} onClick={() => onRemoveSavedQuery(query)}>
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </li>
        )}
        {databaseNames && !currentDb && <li className="node muted">Select a database to see its tables.</li>}
        {databaseNames && currentDb && schemas[0]?.tables.length === 0 &&
          !schemas[0]?.procedures?.length && !schemas[0]?.functions?.length && (
          <li className="node muted">No objects in this database.</li>
        )}
        {(pinnedTables.length > 0 || pinnedProcedures.length > 0) && (
          <li>
            <div className="node tree-group-heading">Favourites</div>
            <ul>
              {pinnedTables.map(({ schema, table }) => renderTable(schema, table, true))}
              {pinnedProcedures.map(({ schema, name }) => renderProcedure(schema, name, true))}
            </ul>
          </li>
        )}
        {schemas.map((s) => {
          const matching = s.tables.filter((t) => t.name.toLowerCase().includes(f))
          const tables = matching.filter((t) => t.type !== 'VIEW')
          const views = matching.filter((t) => t.type === 'VIEW')
          const procedures = (s.procedures ?? []).filter((name) => name.toLowerCase().includes(f))
          const functions = (s.functions ?? []).filter((name) => name.toLowerCase().includes(f))
          if (f && matching.length === 0 && procedures.length === 0 && functions.length === 0) return null
          const isOpen = !!databaseNames || open.has(s.name) || !!f
          return (
            <li key={s.name}>
              {!databaseNames && <div
                className={`node schema ${s.name === currentDb ? 'current' : ''}`}
                tabIndex={onSchemaContextMenu ? 0 : undefined}
                onContextMenu={onSchemaContextMenu ? (event) => {
                  event.preventDefault()
                  onSchemaContextMenu(s.name)
                } : undefined}
                onClick={() => toggle(s.name)}
                onDoubleClick={() => onUseDatabase?.(s.name)}
                title={onUseDatabase ? 'Double-click to make this the current schema' : undefined}
              >
                <span className="twisty">{isOpen ? '▾' : '▸'}</span>🗄 {s.name}
              </div>}
              {isOpen && (
                <ul className="schema-objects">
                  {tables.length > 0 && (
                    <li>
                      <div className="node tree-group-heading">Tables</div>
                      <ul>{tables.map((t) => renderTable(s.name, t))}</ul>
                    </li>
                  )}
                  {views.length > 0 && (
                    <li>
                      <div className="node tree-group-heading">Views</div>
                      <ul>{views.map((t) => renderTable(s.name, t))}</ul>
                    </li>
                  )}
                  {procedures.length > 0 && (
                    <li>
                      <div className="node tree-group-heading">Stored Procedures</div>
                      <ul>{procedures.map((name) => renderProcedure(s.name, name))}</ul>
                    </li>
                  )}
                  {functions.length > 0 && (
                    <li>
                      <div className="node tree-group-heading">Functions</div>
                      <ul>
                        {functions.map((name) => (
                          <li key={name} className="node" title={`${s.name}.${name}`}>
                            <span className="routine-icon" aria-hidden="true">ƒ</span>{name}
                          </li>
                        ))}
                      </ul>
                    </li>
                  )}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
