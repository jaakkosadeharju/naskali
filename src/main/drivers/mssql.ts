import sql from 'mssql'
import type { CellValue, ConnectionInfo, QueryResult, ResultField, SchemaInfo, ServerConnectionConfig, TableDetails } from '../../shared/types'
import { DIALECTS, type Param } from '../dialect'
import type { ColumnMeta } from '../tableQuery'
import { MAX_ROWS, buildSchemaTree, generateDdl, groupForeignKeys, groupIndexes, normalise, type Driver, type Exec, type Rows } from './types'

const NUMERIC_TYPES = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'])

/** mssql's column metadata (array-row mode); `type` is the type function, e.g. sql.Int. */
interface Column {
  name: string
  type?: { declaration?: string }
}

const typeName = (c: Column): string => c.type?.declaration ?? ''

function toFields(columns: Column[]): ResultField[] {
  return columns.map((c) => {
    const type = typeName(c)
    return { name: c.name, type, numeric: NUMERIC_TYPES.has(type) }
  })
}

/** "nvarchar(100)", "decimal(10,2)", … from sys.columns facts. SQL Server's binary `timestamp` is `rowversion`. */
function formatType(name: string, maxLength: number, precision: number, scale: number): string {
  if (name === 'timestamp') return 'rowversion'
  if (['varchar', 'char', 'varbinary', 'binary'].includes(name)) return `${name}(${maxLength === -1 ? 'max' : maxLength})`
  if (['nvarchar', 'nchar'].includes(name)) return `${name}(${maxLength === -1 ? 'max' : maxLength / 2})`
  if (['decimal', 'numeric'].includes(name)) return `${name}(${precision},${scale})`
  if (['datetime2', 'time', 'datetimeoffset'].includes(name)) return `${name}(${scale})`
  return name
}

const COLUMN_EXTRA = `CASE WHEN c.is_computed = 1 THEN 'GENERATED' WHEN c.is_identity = 1 THEN 'identity' ELSE '' END`
const COLUMN_IS_PK = `CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                                       WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id) THEN 1 ELSE 0 END`
/** User schemas: built-in principals' schemas (db_owner …) have ids >= 16384. */
const USER_SCHEMA = `s.schema_id < 16384 AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')`

/**
 * SQL Server via mssql/tedious: a single-connection pool for the editor (so
 * session state like `USE` persists; queries are cancelled with
 * Request.cancel), a small pool for metadata and change transactions.
 * Schemas are the connected database's schemas (dbo …).
 */
export class MssqlDriver implements Driver {
  readonly dialect = DIALECTS.mssql
  private editor: sql.ConnectionPool | null = null
  private meta: sql.ConnectionPool | null = null
  private current: sql.Request | null = null

  constructor(private readonly cfg: ServerConnectionConfig) {}

  private pool(max: number, requestTimeout: number): sql.ConnectionPool {
    const pool = new sql.ConnectionPool({
      server: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database || undefined,
      connectionTimeout: 10_000,
      requestTimeout,
      pool: { min: 0, max },
      arrayRowMode: true,
      options: {
        encrypt: true,
        trustServerCertificate: !!this.cfg.trustServerCertificate,
        appName: 'Naskali',
        // DATETIME values are read as UTC so their wall-clock time comes back unchanged.
        useUTC: true
      }
    })
    pool.on('error', () => undefined) // surfaced by the next request instead
    return pool
  }

  async connect(): Promise<ConnectionInfo> {
    this.meta = await this.pool(4, 30_000).connect()
    try {
      this.editor = await this.pool(1, 0).connect() // no timeout for user queries
    } catch (e) {
      await this.meta.close()
      this.meta = null
      throw e
    }
    const r = await this.objects<{ v: string; db: string; schema: string }>(
      `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, DB_NAME() AS db, SCHEMA_NAME() AS [schema]`
    )
    return { driver: 'mssql', serverVersion: r[0].v, database: r[0].db, schema: r[0].schema, capabilities: { switchSchema: false } }
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.editor?.close().catch(() => undefined), this.meta?.close().catch(() => undefined)])
    this.editor = this.meta = null
    this.current = null
  }

  private requireMeta(): sql.ConnectionPool {
    if (!this.meta) throw new Error('Not connected')
    return this.meta
  }

  query(text: string): Promise<QueryResult> {
    if (!this.editor) return Promise.reject(new Error('Not connected'))
    if (this.current) return Promise.reject(new Error('A query is already running'))
    const req = new sql.Request(this.editor)
    req.stream = true
    req.arrayRowMode = true
    this.current = req
    const started = performance.now()

    return new Promise<QueryResult>((resolve, reject) => {
      let columns: Column[] | null = null
      let readingFirstResultSet = false
      const rows: CellValue[][] = []
      let truncated = false
      let affected = 0
      let stopped = false // we cancelled after MAX_ROWS ourselves

      req.on('recordset', (cols: Column[]) => {
        // Batches can return several result sets; show the first.
        readingFirstResultSet = columns === null
        if (readingFirstResultSet) columns = cols
      })
      req.on('row', (row: unknown[]) => {
        if (stopped || !readingFirstResultSet) return
        if (rows.length >= MAX_ROWS) {
          truncated = stopped = true
          req.cancel()
          return
        }
        rows.push(row.map(normalise))
      })
      req.on('rowsaffected', (n: number) => {
        affected += n
      })
      const finish = (): void => {
        this.current = null
        const elapsedMs = Math.round(performance.now() - started)
        if (columns) {
          resolve({ kind: 'rows', fields: toFields(columns), rows, rowCount: truncated ? null : rows.length, truncated, elapsedMs })
        } else {
          resolve({ kind: 'ok', affectedRows: affected, insertId: null, info: '', elapsedMs })
        }
      }
      req.on('error', (err: Error & { code?: string }) => {
        if (stopped && err.code === 'ECANCEL') return // our own cut-off; 'done' follows
        this.current = null
        reject(err)
      })
      req.on('done', () => {
        if (this.current === req) finish()
      })
      req.query(text)
    })
  }

  async cancel(): Promise<void> {
    this.current?.cancel()
  }

  async currentSchema(): Promise<string | null> {
    return (await this.objects<{ s: string }>('SELECT SCHEMA_NAME() AS s'))[0].s
  }

  async useSchema(): Promise<void> {
    throw new Error("SQL Server can't change the default schema per session; qualify names instead (e.g. sales.orders)")
  }

  private bind(req: sql.Request, params: Param[]): sql.Request {
    params.forEach((v, i) => req.input(`p${i + 1}`, v))
    return req
  }

  async selectRows(text: string, params: Param[]): Promise<Rows> {
    const req = this.bind(this.requireMeta().request(), params)
    req.arrayRowMode = true
    const r = (await req.query(text)) as unknown as { recordset: unknown[][]; columns: Column[][] }
    return { fields: toFields(r.columns[0] ?? []), rows: (r.recordset ?? []).map((row) => row.map(normalise)) }
  }

  async inTransaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    const tx = new sql.Transaction(this.requireMeta())
    await tx.begin()
    try {
      // rowsAffected counts matched rows for UPDATE, also when values don't change.
      const result = await fn(async (text, params) => {
        const r = await this.bind(new sql.Request(tx), params).query(text)
        return r.rowsAffected.reduce((a, b) => a + b, 0)
      })
      await tx.commit()
      return result
    } catch (e) {
      await tx.rollback().catch(() => undefined)
      throw e
    }
  }

  /** Rows as objects (array-row mode turned off for catalog queries). */
  private async objects<T>(text: string, params: Param[] = []): Promise<T[]> {
    const req = this.bind(this.requireMeta().request(), params)
    req.arrayRowMode = false
    return (await req.query(text)).recordset as unknown as T[]
  }

  private async columns(schema: string, table: string) {
    const rows = await this.objects<{
      name: string
      type: string
      maxLength: number
      precision: number
      scale: number
      nullable: boolean
      pk: number
      extra: string
      def: string | null
    }>(
      `SELECT c.name, TYPE_NAME(c.system_type_id) AS type, c.max_length AS maxLength, c.precision, c.scale,
              c.is_nullable AS nullable, ${COLUMN_IS_PK} AS pk, ${COLUMN_EXTRA} AS extra, OBJECT_DEFINITION(c.default_object_id) AS def
       FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @p1 AND o.name = @p2 AND o.type IN ('U', 'V')
       ORDER BY c.column_id`,
      [schema, table]
    )
    return rows.map((r) => ({ ...r, type: formatType(r.type, r.maxLength, r.precision, r.scale) }))
  }

  async columnMeta(schema: string, table: string): Promise<ColumnMeta[]> {
    const cols = await this.columns(schema, table)
    if (cols.length === 0) throw new Error(`Table not found: ${schema}.${table}`)
    return cols.map((c) => ({ name: c.name, type: c.type, key: c.pk ? 'PRI' : '', extra: c.extra, nullable: c.nullable }))
  }

  async introspect(): Promise<SchemaInfo[]> {
    const schemas = await this.objects<{ name: string }>(`SELECT s.name FROM sys.schemas s WHERE ${USER_SCHEMA} ORDER BY s.name`)
    const tables = await this.objects<{ schema: string; table: string; type: string }>(
      `SELECT s.name AS [schema], o.name AS [table], CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS type
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND ${USER_SCHEMA}
       ORDER BY s.name, o.name`
    )
    const columns = await this.objects<{ schema: string; table: string; name: string; type: string; maxLength: number; precision: number; scale: number; nullable: boolean; pk: number }>(
      `SELECT s.name AS [schema], o.name AS [table], c.name, TYPE_NAME(c.system_type_id) AS type, c.max_length AS maxLength,
              c.precision, c.scale, c.is_nullable AS nullable, ${COLUMN_IS_PK} AS pk
       FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND ${USER_SCHEMA}
       ORDER BY s.name, o.name, c.column_id`
    )
    // Keep dbo and schemas that have objects; hide empty role-like schemas.
    const used = new Set(tables.map((t) => t.schema))
    return buildSchemaTree(
      schemas.map((s) => s.name).filter((s) => s === 'dbo' || used.has(s)),
      tables,
      columns.map((c) => ({ ...c, type: formatType(c.type, c.maxLength, c.precision, c.scale), key: c.pk ? 'PRI' : '' }))
    )
  }

  async tableDetails(schema: string, table: string): Promise<TableDetails> {
    const [obj] = await this.objects<{ id: number; type: string; rowsEstimate: number | null; def: string | null; comment: string | null }>(
      `SELECT o.object_id AS id, CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS type,
              (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS rowsEstimate,
              CASE WHEN o.type = 'V' THEN OBJECT_DEFINITION(o.object_id) END AS def,
              CAST((SELECT TOP (1) ep.value FROM sys.extended_properties ep
                    WHERE ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description') AS nvarchar(4000)) AS comment
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @p1 AND o.name = @p2 AND o.type IN ('U', 'V')`,
      [schema, table]
    )
    if (!obj) throw new Error(`Table not found: ${schema}.${table}`)
    const cols = await this.columns(schema, table)
    const indexRows = await this.objects<{ name: string; unique: boolean; type: string; column: string }>(
      `SELECT i.name, i.is_unique AS [unique], i.type_desc AS type, COL_NAME(ic.object_id, ic.column_id) AS [column]
       FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       WHERE i.object_id = @p1 AND i.name IS NOT NULL AND ic.is_included_column = 0
       ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal`,
      [obj.id]
    )
    const fkRows = await this.objects<{ name: string; column: string; refSchema: string; refTable: string; refColumn: string }>(
      `SELECT fk.name, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS [column],
              SCHEMA_NAME(ro.schema_id) AS refSchema, ro.name AS refTable,
              COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS refColumn
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
       WHERE fk.parent_object_id = @p1
       ORDER BY fk.name, fkc.constraint_column_id`,
      [obj.id]
    )
    const details = {
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        key: c.pk ? 'PRI' : '',
        default: c.def,
        extra: c.extra,
        comment: ''
      })),
      indexes: groupIndexes(indexRows),
      foreignKeys: groupForeignKeys(fkRows)
    }
    return {
      schema,
      table,
      type: obj.type,
      engine: null,
      rowsEstimate: obj.rowsEstimate === null ? null : Number(obj.rowsEstimate),
      comment: obj.comment ?? '',
      ...details,
      ddl: obj.def ?? generateDdl(this.dialect, schema, table, details)
    }
  }
}
