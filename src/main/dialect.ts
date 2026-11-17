import mysql from 'mysql2'
import type { CellValue, DriverKind } from '../shared/types'

// SQL dialect differences the generated SQL (table data view, row changes)
// has to care about, plus a tiny statement builder.
//
// Generated statements keep their parameters as neutral markers (\0<index>\0)
// and are rendered per dialect at the end: `render` turns markers into the
// driver's placeholders (?, $1, @p1) in order of appearance, `display` inlines
// literals for "View SQL" / "Open in editor". Identifiers are always quoted by
// the dialect; values are always bound parameters when executed.

export type Param = CellValue

/** A statement (or fragment) with parameter markers in `text`. */
export interface Sql {
  text: string
  params: Param[]
}

const MARKER = /\u0000(\d+)\u0000/g

/** Adds a parameter and returns its marker for embedding in SQL text. */
export function bind(params: Param[], value: Param): string {
  params.push(value)
  return `\u0000${params.length - 1}\u0000`
}

export interface SqlDialect {
  readonly kind: DriverKind
  quote(identifier: string): string
  /** Placeholder for the n-th (1-based) parameter. */
  param(n: number): string
  /** A literal for display purposes (never used for execution). */
  literal(v: Param): string
  /** Characters that must be escaped inside a LIKE pattern (escape char is `!`). */
  readonly likeSpecials: RegExp
  /** The column expression to apply LIKE to (PostgreSQL has no LIKE on non-text types). */
  likeTarget(column: string): string
  /** Appends ordering + paging to `select` (`orderBy` = quoted column names). */
  paginate(select: string, orderBy: string[], limit: number, offset: number): string
  deleteOne(target: string, where: string): string
  updateOne(target: string, set: string, where: string): string
  insertDefaults(target: string): string
}

function checkIdent(id: string): string {
  if (id.includes('\u0000')) throw new Error('Invalid identifier')
  return id
}

const quoteString = (s: string, prefix = ''): string => `${prefix}'${s.replace(/'/g, "''")}'`
const limitOffset = (select: string, orderBy: string[], limit: number, offset: number): string =>
  `${select}${orderBy.length ? ` ORDER BY ${orderBy.join(', ')}` : ''} LIMIT ${limit} OFFSET ${offset}`

const mysqlDialect: SqlDialect = {
  kind: 'mysql',
  quote: (id) => `\`${checkIdent(id).replace(/`/g, '``')}\``,
  param: () => '?',
  literal: (v) => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : mysql.escape(v)),
  likeSpecials: /[!%_]/g,
  likeTarget: (c) => c,
  paginate: limitOffset,
  deleteOne: (t, w) => `DELETE FROM ${t} WHERE ${w} LIMIT 1`,
  updateOne: (t, s, w) => `UPDATE ${t} SET ${s} WHERE ${w} LIMIT 1`,
  insertDefaults: (t) => `INSERT INTO ${t} () VALUES ()`
}

const postgresDialect: SqlDialect = {
  kind: 'postgres',
  quote: (id) => `"${checkIdent(id).replace(/"/g, '""')}"`,
  param: (n) => `$${n}`,
  literal: (v) =>
    v === null ? 'NULL' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(v) : quoteString(v),
  likeSpecials: /[!%_]/g,
  likeTarget: (c) => `CAST(${c} AS text)`,
  paginate: limitOffset,
  // No LIMIT on UPDATE/DELETE; the primary-key WHERE plus the one-row check guard it.
  deleteOne: (t, w) => `DELETE FROM ${t} WHERE ${w}`,
  updateOne: (t, s, w) => `UPDATE ${t} SET ${s} WHERE ${w}`,
  insertDefaults: (t) => `INSERT INTO ${t} DEFAULT VALUES`
}

const sqliteDialect: SqlDialect = {
  ...postgresDialect,
  kind: 'sqlite',
  param: () => '?',
  likeTarget: (c) => c,
  literal: (v) =>
    v === null ? 'NULL' : typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(v) : quoteString(v)
}

const mssqlDialect: SqlDialect = {
  kind: 'mssql',
  quote: (id) => `[${checkIdent(id).replace(/]/g, ']]')}]`,
  param: (n) => `@p${n}`,
  literal: (v) =>
    v === null ? 'NULL' : typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(v) : quoteString(v, 'N'),
  likeSpecials: /[!%_[]/g, // [ starts a character class in T-SQL LIKE
  likeTarget: (c) => c, // implicit conversion to text
  // OFFSET/FETCH needs an ORDER BY; without a primary key, order by nothing in particular.
  paginate: (select, orderBy, limit, offset) =>
    `${select} ORDER BY ${orderBy.length ? orderBy.join(', ') : '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
  deleteOne: (t, w) => `DELETE TOP (1) FROM ${t} WHERE ${w}`,
  updateOne: (t, s, w) => `UPDATE TOP (1) ${t} SET ${s} WHERE ${w}`,
  insertDefaults: (t) => `INSERT INTO ${t} DEFAULT VALUES`
}

export const DIALECTS: Record<DriverKind, SqlDialect> = {
  mysql: mysqlDialect,
  postgres: postgresDialect,
  sqlite: sqliteDialect,
  mssql: mssqlDialect
}

export const qualify = (d: SqlDialect, schema: string, table: string): string => `${d.quote(schema)}.${d.quote(table)}`

/** Escapes LIKE wildcards (for use with `ESCAPE '!'`), so "50%" matches a literal percent sign. */
export const escapeLike = (d: SqlDialect, s: string): string => s.replace(d.likeSpecials, (c) => '!' + c)

/** Executable form: markers → the dialect's placeholders, parameters in order of appearance. */
export function render(sql: Sql, d: SqlDialect): { text: string; params: Param[] } {
  const params: Param[] = []
  const text = sql.text.replace(MARKER, (_, i: string) => {
    params.push(sql.params[Number(i)])
    return d.param(params.length)
  })
  return { text, params }
}

/** Display form with literals inlined – for previews only, never executed by us. */
export function display(sql: Sql, d: SqlDialect): string {
  return sql.text.replace(MARKER, (_, i: string) => d.literal(sql.params[Number(i)]))
}
