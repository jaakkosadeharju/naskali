import mysql, { type SqlValue } from 'mysql2'
import { FILTER_OPS, type CellValue, type ChangeSet, type FilterOp, type RowFilter } from '../shared/types'
import { isEditableColumn } from '../shared/editing'

// Turns UI filter rows into a parameterized WHERE clause. Identifiers are
// checked against the table's real columns *and* escaped; operators come from a
// whitelist; every value is a bound parameter. Nothing user-typed is spliced
// into the SQL text.

const VALID_OPS = new Set<string>(FILTER_OPS)

/** Escapes LIKE wildcards so "contains 50%" means a literal percent sign. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

function splitList(v: string): string[] {
  return v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
}

function condition(col: string, op: FilterOp, value: string, params: SqlValue[]): string {
  switch (op) {
    case 'IS NULL':
    case 'IS NOT NULL':
      return `${col} ${op}`
    case 'contains':
      params.push(`%${escapeLike(value)}%`)
      return `${col} LIKE ?`
    case 'not contains':
      params.push(`%${escapeLike(value)}%`)
      return `${col} NOT LIKE ?`
    case 'starts with':
      params.push(`${escapeLike(value)}%`)
      return `${col} LIKE ?`
    case 'ends with':
      params.push(`%${escapeLike(value)}`)
      return `${col} LIKE ?`
    case 'IN':
    case 'NOT IN': {
      const items = splitList(value)
      if (items.length === 0) throw new Error(`${op} needs a comma-separated list of values`)
      params.push(items)
      return `${col} ${op} (?)`
    }
    default:
      params.push(value)
      return `${col} ${op} ?`
  }
}

export function buildWhere(
  filters: RowFilter[],
  match: 'all' | 'any',
  columns: ReadonlySet<string>
): { clause: string; params: SqlValue[] } {
  const params: SqlValue[] = []
  const parts: string[] = []
  for (const f of filters) {
    if (!f.column) continue // incomplete row in the UI
    if (!columns.has(f.column)) throw new Error(`Unknown column: ${f.column}`)
    if (!VALID_OPS.has(f.op)) throw new Error(`Unsupported operator: ${f.op}`)
    parts.push(condition(mysql.escapeId(f.column), f.op, f.value ?? '', params))
  }
  if (parts.length === 0) return { clause: '', params }
  return { clause: ' WHERE ' + parts.join(match === 'any' ? ' OR ' : ' AND '), params }
}

export interface ColumnMeta {
  name: string
  type: string
  key: string
  extra: string
  nullable: boolean
}

export interface ChangeStatement {
  kind: 'delete' | 'update' | 'insert'
  sql: string
  params: SqlValue[]
}

/**
 * Turns a change set into parameterized statements: deletes, then updates, then
 * inserts. Validates that existing rows are addressed by exactly the table's
 * primary key and that only existing, editable columns are written.
 */
export function buildChangeStatements(cs: ChangeSet, columns: ColumnMeta[]): ChangeStatement[] {
  const pk = columns.filter((c) => c.key === 'PRI').map((c) => c.name)
  if (pk.length === 0) throw new Error(`${cs.table} has no primary key; editing is disabled`)
  const byName = new Map(columns.map((c) => [c.name, c]))
  const target = `${mysql.escapeId(cs.schema)}.${mysql.escapeId(cs.table)}`
  const id = (c: string): string => mysql.escapeId(c)

  const where = (key: Record<string, CellValue>): { sql: string; params: SqlValue[] } => {
    const keyCols = Object.keys(key)
    if (keyCols.length !== pk.length || !pk.every((k) => keyCols.includes(k))) {
      throw new Error('Row key must consist of exactly the primary key columns')
    }
    if (pk.some((k) => key[k] === null)) throw new Error('Primary key value cannot be NULL')
    return { sql: pk.map((k) => `${id(k)} = ?`).join(' AND '), params: pk.map((k) => key[k]) }
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
  for (const d of cs.deletes) {
    const w = where(d.key)
    out.push({ kind: 'delete', sql: `DELETE FROM ${target} WHERE ${w.sql} LIMIT 1`, params: w.params })
  }
  for (const u of cs.updates) {
    const cols = checkWritable(u.set)
    if (cols.length === 0) throw new Error('Update has no changed columns')
    const w = where(u.key)
    out.push({
      kind: 'update',
      sql: `UPDATE ${target} SET ${cols.map((c) => `${id(c)} = ?`).join(', ')} WHERE ${w.sql} LIMIT 1`,
      params: [...cols.map((c) => u.set[c]), ...w.params]
    })
  }
  for (const ins of cs.inserts) {
    const cols = checkWritable(ins.values)
    out.push({
      kind: 'insert',
      // `() VALUES ()` inserts a row of defaults.
      sql: `INSERT INTO ${target} (${cols.map(id).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      params: cols.map((c) => ins.values[c])
    })
  }
  return out
}
