import mysql, { type SqlValue } from 'mysql2'
import { FILTER_OPS, type FilterOp, type RowFilter, type RowUpdate } from '../shared/types'
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

/**
 * Builds one parameterized UPDATE per changed row. Validates that each row is
 * addressed by exactly the table's primary key and only touches existing,
 * editable columns.
 */
export function buildUpdates(
  schema: string,
  table: string,
  updates: RowUpdate[],
  columns: ColumnMeta[]
): { sql: string; params: SqlValue[] }[] {
  const pk = columns.filter((c) => c.key === 'PRI').map((c) => c.name)
  if (pk.length === 0) throw new Error(`${table} has no primary key; editing is disabled`)
  const byName = new Map(columns.map((c) => [c.name, c]))
  const target = `${mysql.escapeId(schema)}.${mysql.escapeId(table)}`

  return updates.map((u) => {
    const keyCols = Object.keys(u.key)
    if (keyCols.length !== pk.length || !pk.every((k) => keyCols.includes(k))) {
      throw new Error('Row key must consist of exactly the primary key columns')
    }
    if (pk.some((k) => u.key[k] === null)) throw new Error('Primary key value cannot be NULL')
    const setCols = Object.keys(u.set)
    if (setCols.length === 0) throw new Error('Update has no changed columns')
    for (const c of setCols) {
      const meta = byName.get(c)
      if (!meta) throw new Error(`Unknown column: ${c}`)
      if (!isEditableColumn(meta)) throw new Error(`Column ${c} is not editable`)
      if (u.set[c] === null && !meta.nullable) throw new Error(`Column ${c} cannot be NULL`)
    }
    const sql =
      `UPDATE ${target} SET ${setCols.map((c) => `${mysql.escapeId(c)} = ?`).join(', ')}` +
      ` WHERE ${pk.map((k) => `${mysql.escapeId(k)} = ?`).join(' AND ')} LIMIT 1`
    return { sql, params: [...setCols.map((c) => u.set[c]), ...pk.map((k) => u.key[k])] }
  })
}
