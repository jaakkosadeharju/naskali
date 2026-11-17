import type { CellValue, ConnectionInfo, QueryResult, ResultField, SchemaInfo, TableDetails } from '../../shared/types'
import type { Param, SqlDialect } from '../dialect'
import type { ColumnMeta } from '../tableQuery'

/** Rows kept from one editor query; the rest is dropped (and, where possible, not even fetched). */
export const MAX_ROWS = 100_000

export interface Rows {
  fields: ResultField[]
  rows: CellValue[][]
  /** Columns containing values that cannot safely be reused as row keys. */
  unsafeKeyColumns?: ReadonlySet<string>
}

/** Runs one statement inside a transaction; resolves to the number of affected (matched) rows. */
export type Exec = (sql: string, params: Param[]) => Promise<number>

/**
 * One connected database. Drivers normalize their catalogs to the app's
 * vocabulary: column key 'PRI' for primary-key columns, table type
 * 'BASE TABLE' | 'VIEW', and 'GENERATED' in `extra` for computed columns.
 *
 * Implementations keep the editor session (user SQL, with its session state)
 * apart from metadata work, so introspection and cancelling don't queue behind
 * a long-running user query.
 */
export interface Driver {
  readonly dialect: SqlDialect
  connect(): Promise<ConnectionInfo>
  disconnect(): Promise<void>

  /** Runs user SQL in the editor session. Results beyond MAX_ROWS are cut off. */
  query(sql: string): Promise<QueryResult>
  /** Cancels the running editor query, if any. */
  cancel(): Promise<void>
  currentSchema(): Promise<string | null>
  /** Only when `capabilities.switchSchema`. */
  useSchema(name: string): Promise<void>

  introspect(): Promise<SchemaInfo[]>
  tableDetails(schema: string, table: string): Promise<TableDetails>
  /** Throws when the table doesn't exist. */
  columnMeta(schema: string, table: string): Promise<ColumnMeta[]>

  /** A row-returning statement with bound parameters, on the metadata connection. */
  selectRows(sql: string, params: Param[]): Promise<Rows>
  /** Runs `fn` in a transaction on a dedicated connection; commits if it resolves, rolls back if it throws. */
  inTransaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T>
}

/** Turns driver values into JSON/IPC-friendly cell values. */
export function normalise(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) {
    const b = Buffer.from(v.buffer, v.byteOffset, v.byteLength)
    const hex = b.subarray(0, 64).toString('hex')
    return `0x${hex}${b.length > 64 ? `… (${b.length} bytes)` : ''}`
  }
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().replace('T', ' ').replace('Z', '')
  // JSON documents, arrays, geometry … come back as objects.
  return JSON.stringify(v)
}

/** Groups flat index/foreign-key rows (one per column) into the TableDetails shapes. */
export function groupIndexes(
  rows: { name: string; unique: boolean; type: string; column: string }[]
): TableDetails['indexes'] {
  const out = new Map<string, TableDetails['indexes'][number]>()
  for (const r of rows) {
    const idx = out.get(r.name) ?? { name: r.name, unique: r.unique, type: r.type, columns: [] }
    idx.columns.push(r.column)
    out.set(r.name, idx)
  }
  return [...out.values()]
}

export function groupForeignKeys(
  rows: { name: string; column: string; refSchema: string; refTable: string; refColumn: string }[]
): TableDetails['foreignKeys'] {
  const out = new Map<string, TableDetails['foreignKeys'][number]>()
  for (const r of rows) {
    const fk = out.get(r.name) ?? { name: r.name, columns: [], refSchema: r.refSchema, refTable: r.refTable, refColumns: [] }
    fk.columns.push(r.column)
    fk.refColumns.push(r.refColumn)
    out.set(r.name, fk)
  }
  return [...out.values()]
}

/** Groups flat (schema, table, column) rows into SchemaInfo[] (schemas without tables included). */
export function buildSchemaTree(
  schemas: string[],
  tables: { schema: string; table: string; type: string }[],
  columns: { schema: string; table: string; name: string; type: string; nullable: boolean; key: string }[]
): SchemaInfo[] {
  const bySchema = new Map<string, SchemaInfo>(schemas.map((s) => [s, { name: s, tables: [] }]))
  const byTable = new Map<string, SchemaInfo['tables'][number]>()
  for (const t of tables) {
    const table = { name: t.table, type: t.type, columns: [] }
    if (!bySchema.has(t.schema)) bySchema.set(t.schema, { name: t.schema, tables: [] })
    bySchema.get(t.schema)!.tables.push(table)
    byTable.set(`${t.schema}\u0000${t.table}`, table)
  }
  for (const c of columns) {
    byTable.get(`${c.schema}\u0000${c.table}`)?.columns.push({ name: c.name, type: c.type, nullable: c.nullable, key: c.key })
  }
  return [...bySchema.values()]
}

/**
 * Builds readable CREATE TABLE text from catalog facts, for databases that
 * can't return the original definition (PostgreSQL, SQL Server).
 */
export function generateDdl(
  d: SqlDialect,
  schema: string,
  table: string,
  details: Pick<TableDetails, 'columns' | 'indexes' | 'foreignKeys'>
): string {
  const q = (s: string): string => d.quote(s)
  const lines = details.columns.map(
    (c) =>
      `  ${q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default !== null ? ` DEFAULT ${c.default}` : ''}${
        c.extra && !/GENERATED/i.test(c.extra) ? ` /* ${c.extra} */` : ''
      }`
  )
  const pk = details.columns.filter((c) => c.key === 'PRI').map((c) => q(c.name))
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`)
  for (const fk of details.foreignKeys) {
    const ref = fk.refSchema === schema ? q(fk.refTable) : `${q(fk.refSchema)}.${q(fk.refTable)}`
    lines.push(
      `  CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map(q).join(', ')})`
    )
  }
  const out = [`-- Reconstructed from the catalog (not the original definition)`, `CREATE TABLE ${q(schema)}.${q(table)} (`, lines.join(',\n'), `);`]
  for (const idx of details.indexes) {
    if (pk.length && idx.columns.length === pk.length && idx.unique && /pk|primary/i.test(idx.name)) continue
    out.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(idx.name)} ON ${q(schema)}.${q(table)} (${idx.columns.join(', ')});`)
  }
  return out.join('\n')
}
