// Types shared between the main process, preload and renderer.

export interface ConnectionConfig {
  host: string
  port: number
  user: string
  password: string
  database?: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  key: string // PRI / UNI / MUL / ''
}

export interface TableInfo {
  name: string
  type: 'BASE TABLE' | 'VIEW' | string
  columns: ColumnInfo[]
}

export interface SchemaInfo {
  name: string
  tables: TableInfo[]
}

export interface ResultField {
  name: string
  type: string
}

/** Cell values are normalised to JSON-friendly primitives before crossing IPC. */
export type CellValue = string | number | boolean | null

export type QueryResult =
  | {
      kind: 'rows'
      fields: ResultField[]
      rows: CellValue[][]
      rowCount: number
      truncated: boolean
      elapsedMs: number
    }
  | {
      kind: 'ok'
      affectedRows: number
      insertId: number
      info: string
      elapsedMs: number
    }

// ---- Table view -----------------------------------------------------------

export const FILTER_OPS = [
  '=', '!=', '<', '<=', '>', '>=',
  'contains', 'not contains', 'starts with', 'ends with',
  'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL'
] as const
export type FilterOp = (typeof FILTER_OPS)[number]
/** Operators that take no value. */
export const UNARY_OPS: ReadonlySet<FilterOp> = new Set(['IS NULL', 'IS NOT NULL'])

export interface RowFilter {
  column: string
  op: FilterOp
  /** For IN / NOT IN: comma-separated list. */
  value: string
}

export interface TableDataRequest {
  schema: string
  table: string
  filters: RowFilter[]
  match: 'all' | 'any'
  offset: number
  limit: number
}

export interface TableDataResult {
  fields: ResultField[]
  rows: CellValue[][]
  total: number
  offset: number
  /** The executed SELECT with values inlined, for display / "open in editor". */
  sql: string
  elapsedMs: number
}

export interface TableDetails {
  schema: string
  table: string
  type: string
  engine: string | null
  rowsEstimate: number | null
  comment: string
  columns: {
    name: string
    type: string
    nullable: boolean
    key: string
    default: string | null
    extra: string
    comment: string
  }[]
  indexes: { name: string; unique: boolean; type: string; columns: string[] }[]
  foreignKeys: { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }[]
  ddl: string
}

// ---- Row editing -----------------------------------------------------------

export interface RowUpdate {
  /** Original primary key values of the row (exactly the PK columns). */
  key: Record<string, CellValue>
  /** New values for changed columns. */
  set: Record<string, CellValue>
}

export interface RowInsert {
  /** Only explicitly set columns; omitted columns get their DEFAULT / auto_increment. */
  values: Record<string, CellValue>
}

export interface RowDelete {
  /** Primary key values of the row to delete (exactly the PK columns). */
  key: Record<string, CellValue>
}

/** Applied in this order: deletes, updates, inserts (so freed unique values can be reused). */
export interface ChangeSet {
  schema: string
  table: string
  deletes: RowDelete[]
  updates: RowUpdate[]
  inserts: RowInsert[]
}

export interface ChangeSummary {
  deleted: number
  updated: number
  inserted: number
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** The API the preload script exposes to the renderer as `window.api`. */
export interface SqlApi {
  connect(config: ConnectionConfig, remember: boolean): Promise<IpcResult<{ serverVersion: string; database: string | null }>>
  disconnect(): Promise<IpcResult<void>>
  loadSavedConnection(): Promise<IpcResult<(ConnectionConfig & { remember: boolean }) | null>>
  introspect(): Promise<IpcResult<SchemaInfo[]>>
  /** Also returns the session's current database, since the SQL may have run `USE ...`. */
  query(sql: string): Promise<IpcResult<{ result: QueryResult; database: string | null }>>
  cancel(): Promise<IpcResult<void>>
  useDatabase(name: string): Promise<IpcResult<void>>
  tableDetails(schema: string, table: string): Promise<IpcResult<TableDetails>>
  tableData(req: TableDataRequest): Promise<IpcResult<TableDataResult>>
  /** The statements `applyChanges` would run, with values inlined (for display). */
  previewChanges(cs: ChangeSet): Promise<IpcResult<string[]>>
  /** Runs the whole change set in one transaction; rolls back if any statement doesn't affect exactly one row. */
  applyChanges(cs: ChangeSet): Promise<IpcResult<ChangeSummary>>
}
