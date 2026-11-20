import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyMatch } from '../fuzzy'
import { lookupDates } from '../lookupDates'
import { tableKey } from '../workspaceStore'
import { temporalCellKind } from '../../../shared/editing'
import { ROW_LOOKUP_OPERATORS, splitRowLookup } from '../../../shared/rowLookup'
import type { ColumnInfo, DriverKind, SchemaInfo } from '../../../shared/types'

const MAX_RESULTS = 50
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isMac ? '⌘' : 'Ctrl+'

interface Props {
  schemas: SchemaInfo[]
  driver: DriverKind
  currentDb: string | null
  /** "schema.table" keys, most recent first. */
  recent: string[]
  favourites: ReadonlySet<string>
  onOpen: (schema: string, table: string, view: 'data' | 'schema') => void
  onRunLookup: (sql: string) => boolean
  onClose: () => void
}

interface Item {
  schema: string
  table: string
  type: string
  columns: ColumnInfo[]
  key: string
}

interface Result extends Item {
  score: number
  /** Matched positions within `label`. */
  positions: number[]
  /** Display text, with the schema when needed. */
  label: string
  recent: boolean
  completion?: string
  detail?: string
}

export function TablePalette({ schemas, driver, currentDb, recent, favourites, onOpen, onRunLookup, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const lookupPending = useRef(false)
  const mounted = useRef(false)
  const separator = query.indexOf('#')
  const rowLookup = separator !== -1
  const tableQuery = (rowLookup ? query.slice(0, separator) : query).trim()
  const lookupExpression = rowLookup ? query.slice(separator + 1).trim() : ''
  const comparison = useMemo(() => splitRowLookup(lookupExpression), [lookupExpression])
  const columnQuery = rowLookup && !comparison ? lookupExpression : null
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo<Item[]>(
    () =>
      schemas.flatMap((s) =>
        s.tables.map((t) => ({ schema: s.name, table: t.name, type: t.type, columns: t.columns, key: `${s.name}.${t.name}` }))
      ),
    [schemas]
  )

  const tableResults = useMemo<Result[]>(() => {
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
    return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  }, [items, tableQuery, rowLookup, recent, currentDb])

  const comparisonTargets = useMemo(() => {
    if (!comparison) return []
    const exact = tableResults.filter(({ label }) => label.toLowerCase() === tableQuery.toLowerCase())
    const candidates = exact.length ? exact : tableResults
    const matches = candidates.filter(({ columns }) => columns.some(({ name }) => name === comparison.column))
    return matches.length ? matches : exact
  }, [comparison, tableResults, tableQuery])

  const results = useMemo(() => {
    const fallback = (comparisonTargets.length ? comparisonTargets : tableResults).slice(0, MAX_RESULTS)
    if (comparison && !comparison.operator.startsWith('IS ') && comparisonTargets.length === 1) {
      const [result] = comparisonTargets
      const column = result.columns.find(({ name }) => name === comparison.column)
      const kind = column && temporalCellKind(column.type, driver === 'mssql')
      if (column && (kind === 'date' || kind === 'timestamp')) {
        const target = `${result.key}#${column.name}`
        const dates = lookupDates(new Date(), kind, driver === 'mssql').map(({ label, value }) => ({
          label, detail: value, completion: `${target}${comparison.operator}${value}`
        }))
        const options = comparison.operator === '='
          ? [...dates, { label: 'Empty (IS NULL)', detail: '', completion: `${target} IS NULL` }]
          : dates
        const matches = options.flatMap((option) => {
          const match = fuzzyMatch(comparison.value, option.label)
          return match ? [{ ...result, ...option, ...match }] : []
        })
        if (matches.length) return matches.sort((a, b) => b.score - a.score)
      }
    }
    if (columnQuery === null) return fallback
    const tableCounts = new Map<string, number>()
    for (const { table } of items) {
      const name = table.toLowerCase()
      tableCounts.set(name, (tableCounts.get(name) ?? 0) + 1)
    }
    const suggestions = tableResults.flatMap((result) => {
      const qualified = result.label === result.key || (tableCounts.get(result.table.toLowerCase()) ?? 0) > 1
      const tableLabel = qualified ? result.key : result.table
      const offset = tableLabel.length - result.label.length
      return result.columns.flatMap(({ name }) => {
        if (splitRowLookup(name)) return []
        const match = fuzzyMatch(columnQuery, name)
        if (!match) return []
        const completion = `${tableLabel}#${name}=`
        return [{
          ...result,
          score: result.score + match.score,
          label: completion,
          completion,
          exact: result.label.toLowerCase() === tableQuery.toLowerCase() && name === columnQuery,
          positions: [
            ...result.positions.map((position) => offset + position),
            ...match.positions.map((position) => tableLabel.length + 1 + position)
          ]
        }]
      })
    })
    const exact = suggestions.filter((suggestion) => suggestion.exact)
    const unique = exact.length === 1 ? exact[0] : suggestions.length === 1 ? suggestions[0] : undefined
    if (unique) {
      const target = unique.completion.slice(0, -1)
      return ROW_LOOKUP_OPERATORS.map((operator) => {
        const completion = target + (operator.startsWith('IS ') ? ` ${operator}` : operator)
        return { ...unique, label: completion, completion }
      })
    }
    return suggestions.length
      ? suggestions.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS)
      : fallback
  }, [columnQuery, comparison, comparisonTargets, driver, items, tableQuery, tableResults])

  const selectedResult = results[selected]
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [results, selected])

  const updateQuery = (value: string): void => {
    setQuery(value)
    setSelected(0)
    setLookupError(null)
  }

  const complete = (value: string): void => {
    if (lookupPending.current) return
    updateQuery(value)
    inputRef.current?.focus()
  }

  const open = async (r: Result | undefined, view: 'data' | 'schema'): Promise<void> => {
    if (!r || lookupPending.current) return
    if (!rowLookup) {
      onOpen(r.schema, r.table, view)
      return
    }
    if (!lookupExpression) {
      setLookupError('Enter a value or column=value after #.')
      return
    }
    if (comparisonTargets.length > 1) {
      setLookupError('Use schema.table to identify a single table for this column.')
      return
    }
    lookupPending.current = true
    setLookingUp(true)
    setLookupError(null)
    try {
      const result = await window.api.rowLookup(r.schema, r.table, lookupExpression)
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
    if (e.key === 'Tab' && !e.shiftKey && selectedResult?.completion && !lookupPending.current) {
      e.preventDefault()
      complete(selectedResult.completion)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.max(0, Math.min(s + 1, results.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setSelected((s) => Math.max(0, Math.min(s + 10, results.length - 1)))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 10, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void open(selectedResult, e.ctrlKey || e.metaKey ? 'schema' : 'data')
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
          ref={inputRef}
          autoFocus
          placeholder="Open table… (fuzzy search)"
          value={query}
          readOnly={lookingUp}
          onChange={(e) => updateQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={selectedResult ? `palette-${selected}` : undefined}
        />
        {results.length === 0 ? (
          <div className="palette-empty">{items.length === 0 ? 'No tables loaded.' : 'No matching tables.'}</div>
        ) : (
          <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
            {results.map((r, i) => (
              <li
                key={r.completion ?? r.key}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? 'selected' : ''}
                onMouseMove={() => i !== selected && setSelected(i)}
                onClick={(e) => {
                  if (r.completion) complete(r.completion)
                  else void open(r, e.ctrlKey || e.metaKey ? 'schema' : 'data')
                }}
              >
                <span className="palette-icon">
                  {favourites.has(tableKey(r.schema, r.table))
                    ? <span className="table-favourite-star" role="img" aria-label="Favourite">★</span>
                    : r.type === 'VIEW' ? '👁' : '▦'}
                </span>
                <span className="palette-name">
                  <Highlight text={r.label} positions={r.positions} />
                </span>
                {r.detail === undefined && !r.label.startsWith(`${r.schema}.`) && <span className="palette-schema">{r.schema}</span>}
                <span className="palette-right">
                  {r.recent && <span className="palette-tag">recent</span>}
                  {r.detail}
                  {!r.completion && `${r.columns.length} col${r.columns.length === 1 ? '' : 's'}`}
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
          {selectedResult?.completion && <span><kbd>Tab</kbd> complete lookup</span>}
          <span><kbd>Table#id</kbd> or <kbd>Table#column=value</kbd></span>
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
