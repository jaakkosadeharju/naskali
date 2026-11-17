import { FILTER_OPS, type CellValue, type ChangeSet, type RowFilter } from '../shared/types'
import { isEditableColumn } from '../shared/editing'
import { bind, escapeLike, qualify, type Param, type Sql, type SqlDialect } from './dialect'

// Turns UI filter rows into a parameterized WHERE clause, and change sets into
// DELETE/UPDATE/INSERT statements. Identifiers are checked against the table's
// real columns *and* quoted by the dialect; operators come from a whitelist;
// every value is a bound parameter. Nothing user-typed is spliced into SQL text.

const VALID_OPS = new Set<string>(FILTER_OPS)

function splitList(v: string): string[] {
  return v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
}

const DECIMAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i

function condition(d: SqlDialect, column: ColumnMeta, filter: RowFilter, params: Param[]): string {
  const col = d.quote(column.name)
  const { op, value = '', operandType } = filter
  const target = d.likeTarget(col)
  const like = (pattern: string, not = false): string => `${target} ${not ? 'NOT ' : ''}LIKE ${bind(params, pattern)} ESCAPE '!'`
  const noAffinity = !column.type || (/BLOB/i.test(column.type) && !/INT|CHAR|CLOB|TEXT/i.test(column.type))
  const operand = (input: string): string => {
    if (d.kind !== 'sqlite' || operandType === 'text' || (operandType !== 'number' && !noAffinity)) return bind(params, input)
    const trimmed = input.trim()
    // Unary + removes CAST's affinity so SQLite won't also coerce the column.
    if (DECIMAL.test(trimmed)) return `+CAST(${bind(params, trimmed)} AS NUMERIC)`
    if (operandType === 'number') throw new Error('Enter a valid number for the filter')
    return bind(params, input)
  }
  switch (op) {
    case 'IS NULL':
    case 'IS NOT NULL':
      return `${col} ${op}`
    case 'contains':
      return like(`%${escapeLike(d, value)}%`)
    case 'not contains':
      return like(`%${escapeLike(d, value)}%`, true)
    case 'starts with':
      return like(`${escapeLike(d, value)}%`)
    case 'ends with':
      return like(`%${escapeLike(d, value)}`)
    case 'LIKE':
    case 'NOT LIKE':
      // Raw patterns: the user's own % and _ wildcards (no ESCAPE clause).
      return `${target} ${op} ${bind(params, value)}`
    case 'IN':
    case 'NOT IN': {
      const items = splitList(value)
      if (items.length === 0) throw new Error(`${op} needs a comma-separated list of values`)
      return `${col} ${op} (${items.map(operand).join(', ')})`
    }
    default:
      return `${col} ${op} ${operand(value)}`
  }
}

/** ` WHERE …` (or empty) for the given filters. */
export function buildWhere(d: SqlDialect, filters: RowFilter[], match: 'all' | 'any', columns: ColumnMeta[]): Sql {
  const params: Param[] = []
  const parts: string[] = []
  const byName = new Map(columns.map((column) => [column.name, column]))
  for (const f of filters) {
    if (!f.column) continue // incomplete row in the UI
    const column = byName.get(f.column)
    if (!column) throw new Error(`Unknown column: ${f.column}`)
    if (!VALID_OPS.has(f.op)) throw new Error(`Unsupported operator: ${f.op}`)
    parts.push(condition(d, column, f, params))
  }
  if (parts.length === 0) return { text: '', params }
  return { text: ' WHERE ' + parts.join(match === 'any' ? ' OR ' : ' AND '), params }
}

/** Normalized column facts used for validation (drivers map their catalogs onto this). */
export interface ColumnMeta {
  name: string
  type: string
  /** 'PRI' for primary-key columns. */
  key: string
  /** Contains 'GENERATED' for computed columns. */
  extra: string
  nullable: boolean
}

export interface ChangeStatement extends Sql {
  kind: 'delete' | 'update' | 'insert'
}

/**
 * Turns a change set into parameterized statements: deletes, then updates, then
 * inserts. Validates that existing rows are addressed by exactly the table's
 * primary key and that only existing, editable columns are written.
 */
export function buildChangeStatements(d: SqlDialect, cs: ChangeSet, columns: ColumnMeta[]): ChangeStatement[] {
  const pk = columns.filter((c) => c.key === 'PRI').map((c) => c.name)
  if (pk.length === 0) throw new Error(`${cs.table} has no primary key; editing is disabled`)
  const byName = new Map(columns.map((c) => [c.name, c]))
  const target = qualify(d, cs.schema, cs.table)

  const where = (key: Record<string, CellValue>, params: Param[]): string => {
    const keyCols = Object.keys(key)
    if (keyCols.length !== pk.length || !pk.every((k) => keyCols.includes(k))) {
      throw new Error('Row key must consist of exactly the primary key columns')
    }
    if (pk.some((k) => key[k] === null)) throw new Error('Primary key value cannot be NULL')
    return pk.map((k) => `${d.quote(k)} = ${bind(params, key[k])}`).join(' AND ')
  }
  const checkWritable = (values: Record<string, CellValue>): string[] => {
    const cols = Object.keys(values)
    for (const c of cols) {
      const meta = byName.get(c)
      if (!meta) throw new Error(`Unknown column: ${c}`)
      if (!isEditableColumn(meta)) throw new Error(`Column ${c} is not editable`)
      if (values[c] === null && !meta.nullable) throw new Error(`Column ${c} cannot be NULL`)
    }
    return cols
  }

  const out: ChangeStatement[] = []
  for (const del of cs.deletes) {
    const params: Param[] = []
    out.push({ kind: 'delete', text: d.deleteOne(target, where(del.key, params)), params })
  }
  for (const u of cs.updates) {
    const cols = checkWritable(u.set)
    if (cols.length === 0) throw new Error('Update has no changed columns')
    const params: Param[] = []
    const set = cols.map((c) => `${d.quote(c)} = ${bind(params, u.set[c])}`).join(', ')
    out.push({ kind: 'update', text: d.updateOne(target, set, where(u.key, params)), params })
  }
  for (const ins of cs.inserts) {
    const cols = checkWritable(ins.values)
    const params: Param[] = []
    const text =
      cols.length === 0
        ? d.insertDefaults(target)
        : `INSERT INTO ${target} (${cols.map((c) => d.quote(c)).join(', ')}) VALUES (${cols.map((c) => bind(params, ins.values[c])).join(', ')})`
    out.push({ kind: 'insert', text, params })
  }
  return out
}
