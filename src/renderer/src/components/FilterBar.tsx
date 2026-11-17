import { FILTER_OPS, UNARY_OPS, type FilterOp, type RowFilter } from '../../../shared/types'

export interface DraftFilter extends RowFilter {
  id: number
}

interface Props {
  columns: string[]
  filters: DraftFilter[]
  match: 'all' | 'any'
  dirty: boolean
  onChange: (filters: DraftFilter[]) => void
  onMatchChange: (m: 'all' | 'any') => void
  onApply: () => void
}

let nextId = 1
export const newFilter = (column: string): DraftFilter => ({ id: nextId++, column, op: '=', value: '' })

function placeholder(op: FilterOp): string {
  if (op === 'IN' || op === 'NOT IN') return 'a, b, c'
  if (op === 'LIKE' || op === 'NOT LIKE') return 'pattern (% and _ wildcards)'
  return 'value'
}

export function FilterBar({ columns, filters, match, dirty, onChange, onMatchChange, onApply }: Props): JSX.Element {
  const update = (id: number, patch: Partial<RowFilter>): void =>
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)))

  return (
    <div className="filter-bar">
      {filters.map((f, i) => (
        <div className="filter-row" key={f.id}>
          <span className="filter-join">
            {i === 0 ? (
              'Where'
            ) : i === 1 ? (
              <select value={match} onChange={(e) => onMatchChange(e.target.value as 'all' | 'any')}>
                <option value="all">and</option>
                <option value="any">or</option>
              </select>
            ) : match === 'all' ? (
              'and'
            ) : (
              'or'
            )}
          </span>
          <select className="filter-col" value={f.column} onChange={(e) => update(f.id, { column: e.target.value })}>
            {columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select className="filter-op" value={f.op} onChange={(e) => update(f.id, { op: e.target.value as FilterOp })}>
            {FILTER_OPS.map((op) => (
              <option key={op}>{op}</option>
            ))}
          </select>
          {UNARY_OPS.has(f.op) ? (
            <span className="filter-value" />
          ) : (
            <input
              className="filter-value"
              value={f.value}
              placeholder={placeholder(f.op)}
              onChange={(e) => update(f.id, { value: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && onApply()}
              autoFocus={f.value === '' && i === filters.length - 1}
            />
          )}
          <button className="icon" title="Remove filter" onClick={() => onChange(filters.filter((x) => x.id !== f.id))}>
            ✕
          </button>
        </div>
      ))}
      <div className="filter-actions">
        <button onClick={() => onChange([...filters, newFilter(columns[0] ?? '')])} disabled={columns.length === 0}>
          + Add filter
        </button>
        {filters.length > 0 && (
          <button
            onClick={() => {
              onChange([])
            }}
          >
            Clear
          </button>
        )}
        <button className={dirty ? 'primary' : ''} onClick={onApply} title="Enter in a value field also applies">
          Apply
        </button>
      </div>
    </div>
  )
}
