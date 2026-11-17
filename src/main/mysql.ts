import mysql, { type Connection, type ConnectionOptions, type FieldPacket, type ResultSetHeader } from 'mysql2'
import type {
  CellValue,
  ChangeSet,
  ChangeSummary,
  ConnectionConfig,
  QueryResult,
  ResultField,
  SchemaInfo,
  TableDataRequest,
  TableDataResult,
  TableDetails
} from '../shared/types'
import { buildChangeStatements, buildWhere, type ColumnMeta } from './tableQuery'

/** Rows beyond this are discarded (still drained from the server, but not kept in memory). */
const MAX_ROWS = 100_000

const TYPE_NAMES = (mysql as unknown as { Types: Record<number, string> }).Types
const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys']

function toOptions(cfg: ConnectionConfig): ConnectionOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    // Keep values JSON/IPC friendly and lossless: dates and big numbers as strings.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    connectTimeout: 10_000
  }
}

function open(cfg: ConnectionConfig): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection(toOptions(cfg))
    conn.connect((err) => (err ? reject(err) : resolve(conn)))
  })
}

function run<T>(conn: Connection, sql: string, values?: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    conn.query(sql, values, (err, res) => (err ? reject(err) : resolve(res as T)))
  })
}

/** Runs a row-returning statement, returning arrays plus field metadata. */
function runRows(conn: Connection, sql: string, values: unknown[]): Promise<{ fields: ResultField[]; rows: CellValue[][] }> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, values, rowsAsArray: true }, (err, res, fields) => {
      if (err) return reject(err)
      resolve({
        fields: (fields as FieldPacket[]).map((f) => ({ name: f.name, type: TYPE_NAMES[f.type ?? -1] ?? String(f.type) })),
        rows: (res as unknown[][]).map((r) => r.map(normalise))
      })
    })
  })
}

function close(conn: Connection | null): void {
  if (!conn) return
  conn.end(() => undefined)
}

function normalise(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return v.toString()
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, 64).toString('hex')
    return `0x${hex}${v.length > 64 ? `… (${v.length} bytes)` : ''}`
  }
  // JSON columns and geometry come back as objects.
  return JSON.stringify(v)
}

/**
 * One MySQL "session": an editor connection that runs user SQL (and therefore
 * keeps session state like `USE db` and variables), plus a separate metadata
 * connection used for introspection and `KILL QUERY` so they never queue
 * behind a long-running user query.
 */
export class MySqlSession {
  private editor: Connection | null = null
  private meta: Connection | null = null
  private config: ConnectionConfig | null = null
  private running = false

  get connected(): boolean {
    return this.editor !== null
  }

  async connect(cfg: ConnectionConfig): Promise<{ serverVersion: string; database: string | null }> {
    await this.disconnect()
    const editor = await open(cfg)
    try {
      this.meta = await open(cfg)
    } catch (e) {
      close(editor)
      throw e
    }
    this.editor = editor
    this.config = cfg
    for (const c of [this.editor, this.meta]) {
      // A dropped connection should surface as "not connected" rather than crash.
      c.on('error', () => {
        if (c === this.editor) this.editor = null
        if (c === this.meta) this.meta = null
      })
    }
    const [row] = await run<{ v: string; db: string | null }[]>(this.editor, 'SELECT VERSION() AS v, DATABASE() AS db')
    return { serverVersion: row.v, database: row.db }
  }

  async disconnect(): Promise<void> {
    close(this.editor)
    close(this.meta)
    this.editor = this.meta = null
    this.config = null
    this.running = false
  }

  private requireEditor(): Connection {
    if (!this.editor) throw new Error('Not connected')
    return this.editor
  }

  private async requireMeta(): Promise<Connection> {
    if (!this.config) throw new Error('Not connected')
    if (!this.meta) this.meta = await open(this.config)
    return this.meta
  }

  async useDatabase(name: string): Promise<void> {
    if (this.running) throw new Error('A query is running')
    await run(this.requireEditor(), `USE ${mysql.escapeId(name)}`)
  }

  async currentDatabase(): Promise<string | null> {
    const [row] = await run<{ db: string | null }[]>(this.requireEditor(), 'SELECT DATABASE() AS db')
    return row.db
  }

  query(sql: string): Promise<QueryResult> {
    const conn = this.requireEditor()
    if (this.running) return Promise.reject(new Error('A query is already running'))
    this.running = true
    const started = performance.now()

    return new Promise<QueryResult>((resolve, reject) => {
      let fields: FieldPacket[] | null = null
      const rows: CellValue[][] = []
      let rowCount = 0
      let header: ResultSetHeader | null = null
      let failed = false

      const q = conn.query({ sql, rowsAsArray: true })
      q.on('error', (err: Error) => {
        failed = true
        this.running = false
        reject(err)
      })
      q.on('fields', (f: FieldPacket[]) => {
        // Statements like CALL can return several result sets; show the first.
        if (!fields) fields = f
      })
      q.on('result', (r: unknown) => {
        if (Array.isArray(r)) {
          rowCount++
          if (rows.length < MAX_ROWS) rows.push(r.map(normalise))
        } else if (!header) {
          header = r as ResultSetHeader
        }
      })
      q.on('end', () => {
        if (failed) return
        this.running = false
        const elapsedMs = Math.round(performance.now() - started)
        if (fields) {
          resolve({
            kind: 'rows',
            fields: fields.map((f) => ({ name: f.name, type: TYPE_NAMES[f.type ?? -1] ?? String(f.type) })),
            rows,
            rowCount,
            truncated: rowCount > rows.length,
            elapsedMs
          })
        } else {
          const h = header as ResultSetHeader | null
          resolve({
            kind: 'ok',
            affectedRows: h?.affectedRows ?? 0,
            insertId: Number(h?.insertId ?? 0),
            info: h?.info ?? '',
            elapsedMs
          })
        }
      })
    })
  }

  /** Cancels the running statement (the connection itself stays open). */
  async cancel(): Promise<void> {
    if (!this.running || !this.editor) return
    const meta = await this.requireMeta()
    await run(meta, `KILL QUERY ${Number(this.editor.threadId)}`)
  }

  async tableDetails(schema: string, table: string): Promise<TableDetails> {
    const meta = await this.requireMeta()
    const [info] = await run<{ type: string; engine: string | null; rowsEstimate: number | null; comment: string }[]>(
      meta,
      `SELECT TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rowsEstimate, TABLE_COMMENT AS comment
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, table]
    )
    if (!info) throw new Error(`Table not found: ${schema}.${table}`)
    const columns = await run<
      { name: string; type: string; nullable: string; key: string; def: string | null; extra: string; comment: string }[]
    >(
      meta,
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS \`key\`,
              COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    const idxRows = await run<{ name: string; nonUnique: number; type: string; col: string | null; expr: string | null }[]>(
      meta,
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, INDEX_TYPE AS type, COLUMN_NAME AS col, EXPRESSION AS expr
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
      [schema, table]
    )
    const fkRows = await run<{ name: string; col: string; refSchema: string; refTable: string; refCol: string }[]>(
      meta,
      `SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS refSchema,
              REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [schema, table]
    )
    const [ddlRow] = await run<Record<string, string>[]>(meta, `SHOW CREATE TABLE ${mysql.escapeId(schema)}.${mysql.escapeId(table)}`)

    const indexes = new Map<string, TableDetails['indexes'][number]>()
    for (const r of idxRows) {
      const idx = indexes.get(r.name) ?? { name: r.name, unique: Number(r.nonUnique) === 0, type: r.type, columns: [] }
      idx.columns.push(r.col ?? `(${r.expr})`)
      indexes.set(r.name, idx)
    }
    const fks = new Map<string, TableDetails['foreignKeys'][number]>()
    for (const r of fkRows) {
      const fk = fks.get(r.name) ?? {
        name: r.name,
        columns: [],
        refTable: r.refSchema === schema ? r.refTable : `${r.refSchema}.${r.refTable}`,
        refColumns: []
      }
      fk.columns.push(r.col)
      fk.refColumns.push(r.refCol)
      fks.set(r.name, fk)
    }

    return {
      schema,
      table,
      type: info.type,
      engine: info.engine,
      rowsEstimate: info.rowsEstimate === null ? null : Number(info.rowsEstimate),
      comment: info.comment,
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable === 'YES',
        key: c.key,
        default: c.def,
        extra: c.extra,
        comment: c.comment
      })),
      indexes: [...indexes.values()],
      foreignKeys: [...fks.values()],
      ddl: ddlRow?.['Create Table'] ?? ddlRow?.['Create View'] ?? ''
    }
  }

  /** One page of a table's rows, filtered server-side. Runs on the metadata connection. */
  async tableData(req: TableDataRequest): Promise<TableDataResult> {
    const meta = await this.requireMeta()
    const started = performance.now()
    const cols = await this.columnMeta(req.schema, req.table)

    const { clause, params } = buildWhere(req.filters, req.match, new Set(cols.map((c) => c.name)))
    const from = `${mysql.escapeId(req.schema)}.${mysql.escapeId(req.table)}`
    // Order by primary key so paging is stable.
    const pk = cols.filter((c) => c.key === 'PRI').map((c) => mysql.escapeId(c.name))
    const orderBy = pk.length ? ` ORDER BY ${pk.join(', ')}` : ''
    const limit = Math.min(Math.max(1, Math.floor(req.limit)), 10_000)
    const offset = Math.max(0, Math.floor(req.offset))

    const selectSql = `SELECT * FROM ${from}${clause}${orderBy} LIMIT ${limit} OFFSET ${offset}`
    const [{ total }] = await run<{ total: string }[]>(meta, `SELECT COUNT(*) AS total FROM ${from}${clause}`, params)
    const { fields, rows } = await runRows(meta, selectSql, params)
    return {
      fields,
      rows,
      total: Number(total),
      offset,
      sql: mysql.format(selectSql, params),
      elapsedMs: Math.round(performance.now() - started)
    }
  }

  private async columnMeta(schema: string, table: string): Promise<ColumnMeta[]> {
    const rows = await run<{ name: string; type: string; key: string; extra: string; nullable: string }[]>(
      await this.requireMeta(),
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS \`key\`, EXTRA AS extra, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    if (rows.length === 0) throw new Error(`Table not found: ${schema}.${table}`)
    return rows.map((r) => ({ ...r, nullable: r.nullable === 'YES' }))
  }

  async previewChanges(cs: ChangeSet): Promise<string[]> {
    const stmts = buildChangeStatements(cs, await this.columnMeta(cs.schema, cs.table))
    return stmts.map((s) => mysql.format(s.sql, s.params) + ';')
  }

  /**
   * Applies a change set atomically on a dedicated short-lived connection, so it
   * can't interleave with other work on the shared connections. Every statement
   * must affect exactly one row (for UPDATE mysql2 reports *matched* rows),
   * otherwise the whole set is rolled back – e.g. when someone else deleted the
   * row meanwhile.
   */
  async applyChanges(cs: ChangeSet): Promise<ChangeSummary> {
    if (!this.config) throw new Error('Not connected')
    const stmts = buildChangeStatements(cs, await this.columnMeta(cs.schema, cs.table))
    const conn = await open(this.config)
    try {
      await run(conn, 'START TRANSACTION')
      for (const s of stmts) {
        let res: ResultSetHeader
        try {
          res = await run<ResultSetHeader>(conn, s.sql, s.params)
        } catch (e) {
          // Say which statement failed; the transaction is rolled back below.
          const err = e as Error & { code?: string }
          throw Object.assign(new Error(`${err.message}. Nothing was saved.\n${mysql.format(s.sql, s.params)}`), { code: err.code })
        }
        if (res.affectedRows !== 1) {
          throw new Error(
            `No row matched – it may have been changed or deleted meanwhile. Nothing was saved.\n${mysql.format(s.sql, s.params)}`
          )
        }
      }
      await run(conn, 'COMMIT')
      const count = (k: string): number => stmts.filter((s) => s.kind === k).length
      return { deleted: count('delete'), updated: count('update'), inserted: count('insert') }
    } catch (e) {
      await run(conn, 'ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      close(conn)
    }
  }

  async introspect(): Promise<SchemaInfo[]> {
    const meta = await this.requireMeta()
    const schemas = await run<{ name: string }[]>(
      meta,
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN (?) ORDER BY SCHEMA_NAME`,
      [SYSTEM_SCHEMAS]
    )
    const tables = await run<{ s: string; t: string; type: string }[]>(
      meta,
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, TABLE_TYPE AS type FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      [SYSTEM_SCHEMAS]
    )
    const columns = await run<{ s: string; t: string; c: string; type: string; nullable: string; k: string }[]>(
      meta,
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_KEY AS k
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA NOT IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      [SYSTEM_SCHEMAS]
    )

    const bySchema = new Map<string, SchemaInfo>(schemas.map((s) => [s.name, { name: s.name, tables: [] }]))
    const byTable = new Map<string, SchemaInfo['tables'][number]>()
    for (const t of tables) {
      const table = { name: t.t, type: t.type, columns: [] }
      bySchema.get(t.s)?.tables.push(table)
      byTable.set(`${t.s}.${t.t}`, table)
    }
    for (const c of columns) {
      byTable.get(`${c.s}.${c.t}`)?.columns.push({
        name: c.c,
        type: c.type,
        nullable: c.nullable === 'YES',
        key: c.k
      })
    }
    return [...bySchema.values()]
  }
}
