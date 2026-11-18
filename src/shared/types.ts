import type { MenuCommand } from './menuCommands'

// Types shared between the main process, preload and renderer.

export type DriverKind = 'mysql' | 'postgres' | 'mssql' | 'sqlite'

export const DRIVER_LABELS: Record<DriverKind, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
  sqlite: 'SQLite'
}

/** A client/server database (MySQL, PostgreSQL, SQL Server). */
export interface ServerConnectionConfig {
  driver: 'mysql' | 'postgres' | 'mssql'
  host: string
  port: number
  user: string
  password: string
  /** MySQL: default database (optional). PostgreSQL/SQL Server: the database to connect to. */
  database?: string
  /** PostgreSQL: connect with TLS. */
  ssl?: boolean
  /** SQL Server: accept a self-signed certificate (typical for local/dev servers). */
  trustServerCertificate?: boolean
}

export interface SqliteConnectionConfig {
  driver: 'sqlite'
  /** Path to the database file. */
  file: string
  readOnly?: boolean
  /** Create the file if it doesn't exist. */
  create?: boolean
}

export type ConnectionConfig = ServerConnectionConfig | SqliteConnectionConfig

export const CONNECTION_COLORS = ['blue', 'green', 'purple', 'amber', 'red'] as const
export type ConnectionColor = typeof CONNECTION_COLORS[number]

export interface SavedConnection {
  id: string
  name: string
  color?: ConnectionColor
  config: ConnectionConfig
}

export interface ConnectionInfo {
  driver: DriverKind
  /** e.g. "8.4.13" */
  serverVersion: string
  /** The connected database (PostgreSQL/SQL Server/SQLite file name); MySQL: current default database. */
  database: string | null
  /** The current schema the tree highlights and autocomplete prefers (MySQL: the database). */
  schema: string | null
  capabilities: {
    /** Double-clicking a schema switches to it (MySQL `USE`, PostgreSQL `search_path`). */
    switchSchema: boolean
  }
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  key: string // PRI / UNI / MUL / ''
}

export interface NewTableColumn {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
}

export interface CreateTableAction {
  kind: 'create'
  schema: string
  table: string
  columns: NewTableColumn[]
  foreignKeys: Pick<TableDetails['foreignKeys'][number], 'columns' | 'refSchema' | 'refTable' | 'refColumns'>[]
}

export type TableAction =
  | CreateTableAction
  | { kind: 'addColumn'; schema: string; table: string; column: Omit<NewTableColumn, 'primaryKey'> }
  | { kind: 'renameColumn'; schema: string; table: string; column: string; name: string }
  | { kind: 'dropColumn'; schema: string; table: string; column: string }
  | { kind: 'drop' | 'truncate'; schema: string; table: string }

export type ExplorerMenuAction = 'new' | 'edit' | 'drop' | 'truncate'

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
  /** Right-align in grids. */
  numeric: boolean
}

/** Cell values are normalised to JSON-friendly primitives before crossing IPC. */
export type CellValue = string | number | boolean | null
export type ExportFormat = 'csv' | 'json'

export type QueryResult =
  | {
      kind: 'rows'
      fields: ResultField[]
      rows: CellValue[][]
      /** Total rows produced; null when the result was cut off without counting the rest. */
      rowCount: number | null
      truncated: boolean
      elapsedMs: number
    }
  | {
      kind: 'ok'
      affectedRows: number | null
      insertId: number | string | null
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
export const COMPARISON_OPS: ReadonlySet<FilterOp> = new Set(['=', '!=', '<', '<=', '>', '>=', 'IN', 'NOT IN'])

export interface RowFilter {
  column: string
  op: FilterOp
  /** For IN / NOT IN: comma-separated list. */
  value: string
  /** SQLite comparison and list operand type. */
  operandType?: 'number' | 'text'
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
  editDisabledReason?: string
}

export interface TableDetails {
  schema: string
  table: string
  type: string
  engine: string | null
  rowsEstimate: number | null
  comment: string
  editDisabledReason?: string
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
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
  setMenuAvailability(commands: MenuCommand[]): void
  connect(config: ConnectionConfig): Promise<IpcResult<ConnectionInfo>>
  testConnection(config: ConnectionConfig): Promise<IpcResult<void>>
  disconnect(): Promise<IpcResult<void>>
  listConnections(): Promise<IpcResult<SavedConnection[]>>
  saveConnection(id: string | null, name: string, config: ConnectionConfig, color: ConnectionColor): Promise<IpcResult<SavedConnection[]>>
  deleteConnection(id: string): Promise<IpcResult<SavedConnection[]>>
  introspect(): Promise<IpcResult<SchemaInfo[]>>
  /** Also returns the session's current schema, since the SQL may have run `USE …` / `SET search_path …`. */
  query(sql: string): Promise<IpcResult<{ result: QueryResult; schema: string | null }>>
  exportRows(format: ExportFormat, name: string, columns: string[], rows: CellValue[][]): Promise<IpcResult<void>>
  cancel(): Promise<IpcResult<void>>
  useSchema(name: string): Promise<IpcResult<void>>
  /** Shows a file picker for a SQLite database; null when cancelled. */
  pickSqliteFile(): Promise<IpcResult<string | null>>
  explorerMenu(target: 'schema' | 'table'): Promise<IpcResult<ExplorerMenuAction | null>>
  previewCreateTable(action: CreateTableAction): Promise<IpcResult<string>>
  changeTable(action: TableAction): Promise<IpcResult<void>>
  tableDetails(schema: string, table: string): Promise<IpcResult<TableDetails>>
  tableData(req: TableDataRequest): Promise<IpcResult<TableDataResult>>
  /** The statements `applyChanges` would run, with values inlined (for display). */
  previewChanges(cs: ChangeSet): Promise<IpcResult<string[]>>
  /** Runs the whole change set in one transaction; rolls back if any statement doesn't affect exactly one row. */
  applyChanges(cs: ChangeSet): Promise<IpcResult<ChangeSummary>>
}
