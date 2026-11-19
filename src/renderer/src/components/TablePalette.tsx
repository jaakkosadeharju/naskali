import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyMatch } from '../fuzzy'
import type { SchemaInfo } from '../../../shared/types'

const MAX_RESULTS = 50
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isMac ? '⌘' : 'Ctrl+'

interface Props {
  schemas: SchemaInfo[]
  currentDb: string | null
  /** "schema.table" keys, most recent first. */
  recent: string[]
  onOpen: (schema: string, table: string, view: 'data' | 'schema') => void
  onRunLookup: (sql: string) => boolean
  onClose: () => void
}

interface Item {
  schema: string
  table: string
  type: string
  columns: number
  key: string
}

interface Result extends Item {
  score: number
  /** Matched positions within `label`. */
  positions: number[]
  /** What the match was made against: the table name, or "schema.table" when the query has a dot. */
  label: string
  recent: boolean
}

export function TablePalette({ schemas, currentDb, recent, onOpen, onRunLookup, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const lookupPending = useRef(false)
  const mounted = useRef(false)
  const separator = query.indexOf('#')
  const rowLookup = separator !== -1
  const tableQuery = (rowLookup ? query.slice(0, separator) : query).trim()
  const keyValue = rowLookup ? query.slice(separator + 1).trim() : ''
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo<Item[]>(
    () =>
      schemas.flatMap((s) =>
        s.tables.map((t) => ({ schema: s.name, table: t.name, type: t.type, columns: t.columns.length, key: `${s.name}.${t.name}` }))
      ),
    [schemas]
  )

  const results = useMemo<Result[]>(() => {
    const q = tableQuery
    if (rowLookup && !q) return []
    const recentRank = new Map(recent.map((k, i) => [k, i]))
    if (!q) {
      // No query: recently opened first, then the current database's tables, then the rest.
      const rank = (it: Item): number =>
        recentRank.has(it.key) ? recentRank.get(it.key)! : it.schema === currentDb ? 1000 : 2000
      return [...items]
        .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
        .slice(0, MAX_RESULTS)
        .map((it) => ({ ...it, score: 0, positions: [], label: it.table, recent: recentRank.has(it.key) }))
    }
    const qualified = q.includes('.')
    const out: Result[] = []
    for (const it of items) {
      const label = qualified ? it.key : it.table
      const m = fuzzyMatch(q, label)
      if (!m) continue
      // Nudge the current database and recently used tables up among similar matches.
      const exactLookup = rowLookup && label.toLowerCase() === q.toLowerCase()
      const bonus = (exactLookup ? 100 : 0) + (it.schema === currentDb ? 15 : 0) +
        (recentRank.has(it.key) ? 25 - Math.min(recentRank.get(it.key)!, 20) : 0)
      out.push({ ...it, score: m.score + bonus, positions: m.positions, label, recent: recentRank.has(it.key) })
    }
    return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, MAX_RESULTS)
  }, [items, tableQuery, rowLookup, recent, currentDb])

  useEffect(() => {
    setSelected(0)
  }, [tableQuery])
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const open = async (r: Result | undefined, view: 'data' | 'schema'): Promise<void> => {
    if (!r || lookupPending.current) return
    if (!rowLookup) {
      onOpen(r.schema, r.table, view)
      return
    }
    if (!keyValue) {
      setLookupError('Enter a primary-key value after #.')
      return
    }
    lookupPending.current = true
    setLookingUp(true)
    setLookupError(null)
    try {
      const result = await window.api.primaryKeyLookup(r.schema, r.table, keyValue)
      if (!mounted.current) return
      if (!result.ok) setLookupError(result.error)
      else if (!onRunLookup(result.value)) setLookupError('Wait for the current operation to finish, then try again.')
    } catch (error) {
      if (mounted.current) setLookupError(error instanceof Error ? error.message : String(error))
    } finally {
      lookupPending.current = false
      if (mounted.current) setLookingUp(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 10, results.length - 1))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 10, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void open(results[selected], e.ctrlKey || e.metaKey ? 'schema' : 'data')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Open table" onKeyDown={onKeyDown}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Open table… (fuzzy search)"
          value={query}
          readOnly={lookingUp}
          onChange={(e) => {
            setQuery(e.target.value)
            setLookupError(null)
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[selected] ? `palette-${selected}` : undefined}
        />
        {results.length === 0 ? (
          <div className="palette-empty">{items.length === 0 ? 'No tables loaded.' : 'No matching tables.'}</div>
        ) : (
          <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
            {results.map((r, i) => (
              <li
                key={r.key}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? 'selected' : ''}
                onMouseMove={() => i !== selected && setSelected(i)}
                onClick={(e) => void open(r, e.ctrlKey || e.metaKey ? 'schema' : 'data')}
              >
                <span className="palette-icon">{r.type === 'VIEW' ? '👁' : '▦'}</span>
                <span className="palette-name">
                  <Highlight text={r.label} positions={r.positions} />
                </span>
                {r.label === r.table && <span className="palette-schema">{r.schema}</span>}
                <span className="palette-right">
                  {r.recent && <span className="palette-tag">recent</span>}
                  {r.columns} col{r.columns === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {lookupError && <div className="palette-lookup-error" role="alert">{lookupError}</div>}
        <div className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> {rowLookup ? 'run row query' : 'open data'}
          </span>
          {!rowLookup && (
            <span><kbd>{MOD}↵</kbd> open schema</span>
          )}
          <span><kbd>Table#id</kbd> look up a row</span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}

function Highlight({ text, positions }: { text: string; positions: number[] }): JSX.Element {
  if (positions.length === 0) return <>{text}</>
  const set = new Set(positions)
  const parts: JSX.Element[] = []
  let i = 0
  while (i < text.length) {
    const hit = set.has(i)
    let j = i
    while (j < text.length && set.has(j) === hit) j++
    parts.push(hit ? <mark key={i}>{text.slice(i, j)}</mark> : <span key={i}>{text.slice(i, j)}</span>)
    i = j
  }
  return <>{parts}</>
}
