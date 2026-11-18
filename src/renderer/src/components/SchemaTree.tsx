import { useState } from 'react'
import type { SchemaInfo } from '../../../shared/types'
import { MOD } from './TablePalette'

interface Props {
  activeTable?: { schema: string; table: string }
  schemas: SchemaInfo[]
  currentDb: string | null
  /** Absent when the database can't switch schemas. */
  onUseDatabase?: (name: string) => void
  onInsert: (text: string) => void
  onOpenTable: (schema: string, table: string, view: 'data' | 'schema') => void
  onRefresh?: () => void
  onDisconnect?: () => void
}

export function SchemaTree({ activeTable, schemas, currentDb, onUseDatabase, onInsert, onOpenTable, onRefresh, onDisconnect }: Props): JSX.Element {
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentDb ? [currentDb] : []))
  const [filter, setFilter] = useState('')
  const toggle = (key: string): void =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const f = filter.toLowerCase()

  return (
    <div className="schema-tree">
      <div className="tree-heading">
        <h2 className="pane-heading">Database explorer</h2>
        <div className="tree-actions">
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
      <div className="tree-filter">
        <input aria-label="Filter tables" placeholder={`Filter (${MOD}P: open table)`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ul>
        {schemas.map((s) => {
          const tables = f ? s.tables.filter((t) => t.name.toLowerCase().includes(f)) : s.tables
          if (f && tables.length === 0) return null
          const isOpen = open.has(s.name) || !!f
          return (
            <li key={s.name}>
              <div
                className={`node schema ${s.name === currentDb ? 'current' : ''}`}
                onClick={() => toggle(s.name)}
                onDoubleClick={() => onUseDatabase?.(s.name)}
                title={onUseDatabase ? 'Double-click to make this the current schema' : undefined}
              >
                <span className="twisty">{isOpen ? '▾' : '▸'}</span>🗄 {s.name}
              </div>
              {isOpen && (
                <ul>
                  {tables.map((t) => {
                    const key = `${s.name}.${t.name}`
                    return (
                      <li key={key}>
                        <div
                          className={`node table-node${activeTable?.schema === s.name && activeTable.table === t.name ? ' selected' : ''}`}
                          onDoubleClick={() => onOpenTable(s.name, t.name, 'data')}
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
                            {t.type === 'VIEW' ? '👁' : '▦'} {t.name}
                          </span>
                          <span className="node-actions" onDoubleClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              title="Open data"
                              aria-label={`Open data for ${t.name}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                onOpenTable(s.name, t.name, 'data')
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
                                onOpenTable(s.name, t.name, 'schema')
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
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
