import mysql, { type Connection, type ConnectionOptions, type FieldPacket, type ResultSetHeader } from 'mysql2'
import type { ConnectionInfo, QueryResult, QueryResultSet, ResultField, SchemaInfo, ServerConnectionConfig, TableDetails } from '../../shared/types'
import { DIALECTS, type Param } from '../dialect'
import type { ColumnMeta } from '../tableQuery'
import { MAX_ROWS, buildSchemaTree, groupForeignKeys, groupIndexes, normalise, type Driver, type Exec, type Rows } from './types'

const TYPE_NAMES = (mysql as unknown as { Types: Record<number, string> }).Types
const NUMERIC_TYPES = new Set(['DECIMAL', 'NEWDECIMAL', 'TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'FLOAT', 'DOUBLE', 'YEAR'])
const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys']

// With bigNumberStrings enabled, mysql2 can return a string despite its declaration.
type QueryHeader = Omit<ResultSetHeader, 'insertId'> & { insertId: number | string }

function toField(f: FieldPacket): ResultField {
  const type = TYPE_NAMES[f.type ?? -1] ?? String(f.type)
  const field: ResultField = { name: f.name, type, numeric: NUMERIC_TYPES.has(type) }
  // Expressions come without an original table; derived tables and views report their own name.
  const schema = f.db ?? f.schema
  if (schema && f.orgTable && f.orgName) field.source = { schema, table: f.orgTable, column: f.orgName }
  return field
}

function open(cfg: ServerConnectionConfig): Promise<Connection> {
  const options: ConnectionOptions = {
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
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection(options)
    conn.connect((err) => (err ? reject(err) : resolve(conn)))
  })
}

function run<T>(conn: Connection, sql: string, values?: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    conn.query(sql, values, (err, res) => (err ? reject(err) : resolve(res as T)))
  })
}

function close(conn: Connection | null): void {
  if (!conn) return
  conn.end(() => undefined)
}

/**
 * MySQL: an editor connection that runs user SQL (keeping session state like
 * `USE db`), plus a metadata connection used for introspection, the data view
 * and `KILL QUERY`. Schemas are MySQL databases.
 */
export class MySqlDriver implements Driver {
  readonly dialect = DIALECTS.mysql
  private editor: Connection | null = null
  private meta: Connection | null = null
  private running = false

  constructor(private readonly cfg: ServerConnectionConfig) {}

  async connect(): Promise<ConnectionInfo> {
    const editor = await open(this.cfg)
    try {
      this.meta = await open(this.cfg)
    } catch (e) {
      close(editor)
      throw e
    }
    this.editor = editor
    for (const c of [this.editor, this.meta]) {
      // A dropped connection should surface as "not connected" rather than crash.
      c.on('error', () => {
        if (c === this.editor) this.editor = null
        if (c === this.meta) this.meta = null
      })
    }
    const [row] = await run<{ v: string; db: string | null }[]>(this.editor, 'SELECT VERSION() AS v, DATABASE() AS db')
    return { driver: 'mysql', serverVersion: row.v, database: row.db, schema: row.db, capabilities: { switchSchema: true } }
  }

  async disconnect(): Promise<void> {
    close(this.editor)
    close(this.meta)
    this.editor = this.meta = null
    this.running = false
  }

  private requireEditor(): Connection {
    if (!this.editor) throw new Error('Not connected')
    return this.editor
  }

  private async requireMeta(): Promise<Connection> {
    if (!this.meta) this.meta = await open(this.cfg)
    return this.meta
  }

  async useSchema(name: string): Promise<void> {
    if (this.running) throw new Error('A query is running')
    await run(this.requireEditor(), `USE ${this.dialect.quote(name)}`)
  }

  async beginEditorTransaction(): Promise<void> {
    await run(this.requireEditor(), 'START TRANSACTION')
  }

  async endEditorTransaction(action: 'commit' | 'rollback'): Promise<void> {
    await run(this.requireEditor(), action === 'commit' ? 'COMMIT AND NO CHAIN NO RELEASE' : 'ROLLBACK AND NO CHAIN NO RELEASE')
  }

  async editorTransactionStatus(): Promise<'active' | 'idle'> {
    // The OK packet reports the actual transaction state, including implicit commits.
    const result = await run<ResultSetHeader>(this.requireEditor(), 'DO 0')
    return (result.serverStatus & 1) !== 0 ? 'active' : 'idle'
  }

  async currentSchema(): Promise<string | null> {
    const [row] = await run<{ db: string | null }[]>(this.requireEditor(), 'SELECT DATABASE() AS db')
    return row.db
  }

  query(sql: string): Promise<QueryResult> {
    const conn = this.requireEditor()
    if (this.running) return Promise.reject(new Error('A query is already running'))
    this.running = true
    const started = performance.now()

    return new Promise<QueryResult>((resolve, reject) => {
      const resultSets: QueryResultSet[] = []
      let current: QueryResultSet | undefined
      let retainedRows = 0
      let header: QueryHeader | null = null
      let failed = false

      const q = conn.query({ sql, rowsAsArray: true })
      q.on('error', (err: Error) => {
        failed = true
        this.running = false
        reject(err)
      })
      q.on('fields', (fields: FieldPacket[] | undefined) => {
        // MySQL sends an OK packet without fields after a CALL.
        if (!fields) return
        current = { fields: fields.map(toField), rows: [], rowCount: 0, truncated: false }
        resultSets.push(current)
      })
      q.on('result', (r: unknown) => {
        if (Array.isArray(r)) {
          if (!current) return
          current.rowCount = (current.rowCount ?? 0) + 1
          if (retainedRows < MAX_ROWS) {
            current.rows.push(r.map(normalise))
            retainedRows++
          } else current.truncated = true
        } else if (!header) {
          header = r as QueryHeader
        }
      })
      q.on('end', () => {
        if (failed) return
        this.running = false
        const elapsedMs = Math.round(performance.now() - started)
        const [first, ...additionalResults] = resultSets
        if (first) {
          resolve({ kind: 'rows', ...first, elapsedMs, additionalResults })
        } else {
          const h = header as QueryHeader | null
          const insertId = h?.insertId
          resolve({
            kind: 'ok',
            affectedRows: h?.affectedRows ?? 0,
            insertId: insertId === 0 || insertId === '0' ? null : insertId ?? null,
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
    await run(await this.requireMeta(), `KILL QUERY ${Number(this.editor.threadId)}`)
  }

  async selectRows(sql: string, params: Param[]): Promise<Rows> {
    const meta = await this.requireMeta()
    return new Promise((resolve, reject) => {
      meta.query({ sql, values: params, rowsAsArray: true }, (err, res, fields) => {
        if (err) return reject(err)
        resolve({ fields: (fields as FieldPacket[]).map(toField), rows: (res as unknown[][]).map((r) => r.map(normalise)) })
      })
    })
  }

  async inTransaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    const conn = await open(this.cfg)
    try {
      await run(conn, 'START TRANSACTION')
      // mysql2 reports *matched* rows for UPDATE (CLIENT_FOUND_ROWS), so an unchanged value still counts.
      const result = await fn(async (sql, params) => (await run<ResultSetHeader>(conn, sql, params)).affectedRows)
      await run(conn, 'COMMIT')
      return result
    } catch (e) {
      await run(conn, 'ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      close(conn)
    }
  }

  async columnMeta(schema: string, table: string): Promise<ColumnMeta[]> {
    const rows = await run<{ name: string; type: string; key: string; extra: string; nullable: string; default: string | null }[]>(
      await this.requireMeta(),
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS \`key\`, EXTRA AS extra, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS \`default\`
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    if (rows.length === 0) throw new Error(`Table not found: ${schema}.${table}`)
    return rows.map((r) => ({ ...r, nullable: r.nullable === 'YES' }))
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
    const fkRows = await run<{ name: string; column: string; refSchema: string; refTable: string; refColumn: string }[]>(
      meta,
      `SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS \`column\`, REFERENCED_TABLE_SCHEMA AS refSchema,
              REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [schema, table]
    )
    const [ddlRow] = await run<Record<string, string>[]>(meta, `SHOW CREATE TABLE ${this.dialect.quote(schema)}.${this.dialect.quote(table)}`)

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
      indexes: groupIndexes(
        idxRows.map((r) => ({ name: r.name, unique: Number(r.nonUnique) === 0, type: r.type, column: r.col ?? `(${r.expr})` }))
      ),
      foreignKeys: groupForeignKeys(fkRows),
      ddl: ddlRow?.['Create Table'] ?? ddlRow?.['Create View'] ?? ''
    }
  }

  async introspect(): Promise<SchemaInfo[]> {
    const meta = await this.requireMeta()
    const schemas = await run<{ name: string }[]>(
      meta,
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (?) ORDER BY SCHEMA_NAME`,
      [SYSTEM_SCHEMAS]
    )
    const tables = await run<{ schema: string; table: string; type: string }[]>(
      meta,
      `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, TABLE_TYPE AS type FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      [SYSTEM_SCHEMAS]
    )
    const columns = await run<{ schema: string; table: string; name: string; type: string; nullable: string; key: string }[]>(
      meta,
      `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, COLUMN_NAME AS name, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_KEY AS \`key\`
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA NOT IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      [SYSTEM_SCHEMAS]
    )
    const functions = await run<{ schema: string; name: string }[]>(
      meta,
      `SELECT ROUTINE_SCHEMA AS \`schema\`, ROUTINE_NAME AS name FROM information_schema.ROUTINES
       WHERE ROUTINE_TYPE = 'FUNCTION' AND ROUTINE_SCHEMA NOT IN (?) ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`,
      [SYSTEM_SCHEMAS]
    )
    return buildSchemaTree(
      schemas.map((s) => s.name),
      tables,
      columns.map((c) => ({ ...c, nullable: c.nullable === 'YES' })),
      functions
    )
  }
}
