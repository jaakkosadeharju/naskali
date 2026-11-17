import { useState } from 'react'
import type { SchemaInfo } from '../../../shared/types'

interface Props {
  schemas: SchemaInfo[]
  currentDb: string | null
  onUseDatabase: (name: string) => void
  onInsert: (text: string) => void
  onOpenTable: (schema: string, table: string, view: 'data' | 'schema') => void
  onRefresh: () => void
}

export function SchemaTree({ schemas, currentDb, onUseDatabase, onInsert, onOpenTable, onRefresh }: Props): JSX.Element {
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
      <div className="tree-header">
        <input placeholder="Filter tables…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button title="Refresh schema" onClick={onRefresh}>
          ⟳
        </button>
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
                onDoubleClick={() => onUseDatabase(s.name)}
                title="Double-click to USE this database"
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
                          className="node table-node"
                          onClick={() => toggle(key)}
                          onDoubleClick={() => onOpenTable(s.name, t.name, 'data')}
                          title="Double-click to open data"
                        >
                          <span className="table-label">
                            <span className="twisty">{open.has(key) ? '▾' : '▸'}</span>
                            {t.type === 'VIEW' ? '👁' : '▦'} {t.name}
                          </span>
                          <span className="node-actions" onDoubleClick={(e) => e.stopPropagation()}>
                            <button
                              title="Open data"
                              onClick={(e) => {
                                e.stopPropagation()
                                onOpenTable(s.name, t.name, 'data')
                              }}
                            >
                              Data
                            </button>
                            <button
                              title="Open schema"
                              onClick={(e) => {
                                e.stopPropagation()
                                onOpenTable(s.name, t.name, 'schema')
                              }}
                            >
                              Schema
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
