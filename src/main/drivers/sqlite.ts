import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Worker } from 'node:worker_threads'
import type { ConnectionInfo, QueryResult, ResultField, SchemaInfo, SqliteConnectionConfig, TableDetails } from '../../shared/types'
import { DIALECTS, type Param } from '../dialect'
import type { ColumnMeta } from '../tableQuery'
import { MAX_ROWS, buildSchemaTree, groupForeignKeys, groupIndexes, normalise, type Driver, type Exec, type Rows } from './types'
import type { QueryReply, WorkerRequest } from './sqliteWorker'
import type { WorkerField } from './sqliteColumns'

/** A running sqliteWorker – as a worker thread or a child process. */
export interface Endpoint {
  post(message: unknown): void
  onMessage(cb: (message: unknown) => void): void
  /** Called once when it stops (crash, kill, or after `kill()`). */
  onExit(cb: (error?: Error) => void): void
  kill(): Promise<void>
}

export function threadEndpoint(worker: Worker): Endpoint {
  return {
    post: (m) => worker.postMessage(m),
    onMessage: (cb) => worker.on('message', cb),
    onExit: (cb) => {
      worker.on('error', (e: Error) => cb(e))
      worker.on('exit', () => cb())
    },
    kill: async () => void (await worker.terminate())
  }
}

/** Child process started with `serialization: 'advanced'` and an IPC channel. */
export function processEndpoint(child: ChildProcess): Endpoint {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return {
    post: (m) => child.send(m as never),
    onMessage: (cb) => child.on('message', cb),
    onExit: (cb) => {
      child.on('error', (e) => cb(e))
      child.on('exit', () => cb())
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  }
}

/** How to start sqliteWorker: as a thread (metadata) and as a killable process (editor). See drivers/index.ts. */
export interface SqliteSpawners {
  thread: () => Endpoint
  process: () => Endpoint
}

type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

/** Promise wrapper around one SQLite worker (= one connection). */
class WorkerConnection {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(private readonly endpoint: Endpoint) {
    endpoint.onMessage((raw) => {
      const m = raw as { id: number; ok: boolean; value?: unknown; error?: string; code?: string }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else p.reject(Object.assign(new Error(m.error), { code: m.code }))
    })
    endpoint.onExit((error) => {
      for (const p of this.pending.values()) p.reject(error ?? new Error('Query cancelled'))
      this.pending.clear()
    })
  }

  call<T>(req: Req): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.endpoint.post({ ...req, id })
    })
  }

  terminate(): Promise<void> {
    return this.endpoint.kill()
  }
}

/** Declared types with numeric affinity (SQLite's rules, minus NUMERIC-affinity date types). */
const NUMERIC_DECL = /INT|REAL|FLOA|DOUB|DEC|NUMERIC/i

export function toFields(fields: WorkerField[], rows: unknown[][]): ResultField[] {
  return fields.map((f, i) => {
    // Expressions have no declared type: look at the values instead.
    const sample = f.type === null ? rows.find((r) => r[i] !== null)?.[i] : undefined
    const field: ResultField = {
      name: f.name,
      type: f.type ?? (sample === undefined ? '' : typeof sample === 'string' ? 'TEXT' : typeof sample === 'object' ? 'BLOB' : 'NUMERIC'),
      numeric: f.type !== null ? NUMERIC_DECL.test(f.type) : typeof sample === 'number' || typeof sample === 'bigint'
    }
    // Schemas are SQLite database names (main, temp or an attachment).
    if (f.source) field.source = { schema: f.source.database, table: f.source.table, column: f.source.column }
    // NULL keys only make their own row read-only (e.g. the missing side of an outer join).
    if (rows.some((r) => r[i] !== null && isUnsafeKeyValue(r[i]))) field.unsafeKey = true
    return field
  })
}

function sqliteInteger(v: bigint): number | string {
  const number = Number(v)
  return Number.isSafeInteger(number) ? number : v.toString()
}

function sqliteValue(v: unknown) {
  return typeof v === 'bigint' ? sqliteInteger(v) : normalise(v)
}

function isUnsafeKeyValue(v: unknown): boolean {
  if (typeof v === 'bigint') return !Number.isSafeInteger(Number(v))
  if (typeof v === 'number') return !Number.isFinite(v)
  return v === null || v instanceof Uint8Array
}

function requireMainSchema(schema: string): void {
  if (schema !== 'main') throw new Error('SQLite table tools are available for the main database only')
}

/**
 * SQLite through node:sqlite: the editor connection runs in a child process
 * (killed and reopened to cancel a statement), the metadata connection – data
 * view, introspection, change transactions – in a worker thread.
 * Table tools browse `main`. Attachments belong to the editor session.
 */
export class SqliteDriver implements Driver {
  readonly dialect = DIALECTS.sqlite
  /** A promise so queries issued while the editor reopens after a cancel wait for it. */
  private editor: Promise<WorkerConnection> | null = null
  private meta: WorkerConnection | null = null
  private running = false

  constructor(
    private readonly cfg: SqliteConnectionConfig,
    private readonly spawners: SqliteSpawners
  ) {}

  private async open(kind: keyof SqliteSpawners): Promise<WorkerConnection> {
    const conn = new WorkerConnection(this.spawners[kind]())
    try {
      await conn.call({ op: 'open', file: this.cfg.file, readOnly: !!this.cfg.readOnly })
    } catch (e) {
      await conn.terminate()
      throw e
    }
    return conn
  }

  async connect(): Promise<ConnectionInfo> {
    if (!this.cfg.file) throw new Error('Choose a database file')
    if (!existsSync(this.cfg.file) && (this.cfg.readOnly || !this.cfg.create)) {
      throw new Error(`File not found: ${this.cfg.file}${this.cfg.readOnly ? '' : ' (tick "Create the file" to create a new database)'}`)
    }
    this.meta = await this.open('thread')
    const editor = this.open('process')
    this.editor = editor
    await editor
    const version = await this.selectRows('SELECT sqlite_version()', [])
    return {
      driver: 'sqlite',
      serverVersion: String(version.rows[0][0]),
      database: basename(this.cfg.file),
      schema: 'main',
      capabilities: { switchSchema: false }
    }
  }

  async disconnect(): Promise<void> {
    const editor = await this.editor?.catch(() => null)
    await Promise.all([editor?.terminate(), this.meta?.terminate()])
    this.editor = this.meta = null
    this.running = false
  }

  private requireMeta(): WorkerConnection {
    if (!this.meta) throw new Error('Not connected')
    return this.meta
  }

  async query(sql: string): Promise<QueryResult> {
    if (!this.editor) throw new Error('Not connected')
    if (this.running) throw new Error('A query is already running')
    this.running = true
    const started = performance.now()
    try {
      const editor = await this.editor
      const r = await editor.call<QueryReply>({ op: 'query', sql, max: MAX_ROWS })
      const elapsedMs = Math.round(performance.now() - started)
      if (r.kind === 'ok') {
        const insertId = r.lastInsertRowid === null ? null : sqliteInteger(r.lastInsertRowid)
        return { kind: 'ok', affectedRows: r.changes, insertId, info: '', elapsedMs }
      }
      return {
        kind: 'rows',
        fields: toFields(r.fields, r.rows),
        rows: r.rows.map((row) => row.map(sqliteValue)),
        rowCount: r.truncated ? null : r.rows.length,
        truncated: r.truncated,
        elapsedMs
      }
    } finally {
      this.running = false
    }
  }

  /** node:sqlite can't interrupt a statement, so the editor process is killed and replaced. */
  async cancel(): Promise<void> {
    if (!this.running || !this.editor) return
    const old = await this.editor
    const next = old.terminate().then(() => this.open('process')) // rejects the running query with "Query cancelled"
    this.editor = next
    await next
  }

  async currentSchema(): Promise<string | null> {
    return 'main'
  }

  async useSchema(): Promise<void> {
    throw new Error('SQLite has no current schema to switch; qualify names with the attached database instead')
  }

  async selectRows(sql: string, params: Param[]): Promise<Rows> {
    const r = await this.requireMeta().call<{ fields: WorkerField[]; rows: unknown[][] }>({ op: 'select', sql, params })
    const unsafeKeyColumns = new Set<string>()
    const rows = r.rows.map((row) => row.map((value, i) => {
      if (isUnsafeKeyValue(value)) unsafeKeyColumns.add(r.fields[i].name)
      return sqliteValue(value)
    }))
    return { fields: toFields(r.fields, r.rows), rows, unsafeKeyColumns }
  }

  async inTransaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    if (this.cfg.readOnly) throw new Error('This SQLite connection is read-only')
    const meta = this.requireMeta()
    await meta.call({ op: 'script', sql: 'BEGIN IMMEDIATE' })
    try {
      const result = await fn((sql, params) => meta.call<number>({ op: 'exec', sql, params }))
      await meta.call({ op: 'script', sql: 'COMMIT' })
      return result
    } catch (e) {
      await meta.call({ op: 'script', sql: 'ROLLBACK' }).catch(() => undefined)
      throw e
    }
  }

  private async objects<T>(sql: string, params: Param[]): Promise<T[]> {
    const r = await this.selectRows(sql, params)
    return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, row[i]])) as T)
  }

  private async xinfo(schema: string, table: string) {
    return this.objects<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }>(
      'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid',
      [table, schema]
    )
  }

  async columnMeta(schema: string, table: string): Promise<ColumnMeta[]> {
    requireMainSchema(schema)
    const cols = await this.xinfo(schema, table)
    if (cols.length === 0) throw new Error(`Table not found: ${schema}.${table}`)
    return cols
      .filter((c) => c.hidden !== 1) // hidden virtual-table columns
      .map((c) => ({
        name: c.name,
        type: c.type,
        key: c.pk > 0 ? 'PRI' : '',
        extra: c.hidden === 2 || c.hidden === 3 ? 'GENERATED' : '',
        nullable: !c.notnull
      }))
  }

  async introspect(): Promise<SchemaInfo[]> {
    const schemas = ['main']
    const tables: { schema: string; table: string; type: string }[] = []
    const columns: { schema: string; table: string; name: string; type: string; nullable: boolean; key: string }[] = []
    for (const schema of schemas) {
      const master = `${this.dialect.quote(schema)}.sqlite_master`
      for (const t of await this.objects<{ name: string; type: string }>(
        `SELECT name, type FROM ${master} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY name`,
        []
      )) {
        tables.push({ schema, table: t.name, type: t.type === 'view' ? 'VIEW' : 'BASE TABLE' })
      }
      for (const c of await this.objects<{ t: string; name: string; type: string; notnull: number; pk: number }>(
        `SELECT m.name AS t, p.name, p.type, p."notnull", p.pk
         FROM ${master} m JOIN pragma_table_xinfo(m.name, ?) p
         WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite!_%' ESCAPE '!' AND p.hidden <> 1
         ORDER BY m.name, p.cid`,
        [schema]
      )) {
        columns.push({ schema, table: c.t, name: c.name, type: c.type, nullable: !c.notnull, key: c.pk > 0 ? 'PRI' : '' })
      }
    }
    return buildSchemaTree(schemas, tables, columns)
  }

  async tableDetails(schema: string, table: string): Promise<TableDetails> {
    requireMainSchema(schema)
    const master = `${this.dialect.quote(schema)}.sqlite_master`
    const [obj] = await this.objects<{ type: string; sql: string | null }>(`SELECT type, sql FROM ${master} WHERE name = ? AND type IN ('table', 'view')`, [table])
    if (!obj) throw new Error(`Table not found: ${schema}.${table}`)
    const cols = (await this.xinfo(schema, table)).filter((c) => c.hidden !== 1)
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)

    const indexList = await this.objects<{ name: string; unique: number; origin: string }>(
      'SELECT name, "unique", origin FROM pragma_index_list(?, ?)',
      [table, schema]
    )
    const indexRows: { name: string; unique: boolean; type: string; column: string }[] = []
    for (const idx of indexList) {
      for (const c of await this.objects<{ name: string | null }>('SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno', [idx.name, schema])) {
        indexRows.push({ name: idx.name, unique: !!idx.unique, type: idx.origin === 'pk' ? 'PRIMARY KEY' : 'BTREE', column: c.name ?? '(expression)' })
      }
    }
    // An INTEGER PRIMARY KEY is the rowid itself and has no index entry.
    if (pkCols.length && !indexList.some((i) => i.origin === 'pk')) {
      for (const c of pkCols) indexRows.unshift({ name: 'PRIMARY (rowid)', unique: true, type: 'ROWID', column: c.name })
    }

    const fkRows = await this.objects<{ id: number; table: string; from: string; to: string | null }>(
      'SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq',
      [table, schema]
    )
    // `to` is NULL when the FK references the parent's primary key implicitly.
    const parentPk = new Map<string, string[]>()
    for (const r of fkRows) {
      if (r.to !== null || parentPk.has(r.table)) continue
      parentPk.set(r.table, (await this.xinfo(schema, r.table)).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name))
    }
    const fkSeq = new Map<number, number>()
    const foreignKeys = groupForeignKeys(
      fkRows.map((r) => {
        const seq = fkSeq.get(r.id) ?? 0
        fkSeq.set(r.id, seq + 1)
        return { name: `fk_${table}_${r.id}`, column: r.from, refSchema: schema, refTable: r.table, refColumn: r.to ?? parentPk.get(r.table)?.[seq] ?? '' }
      })
    )

    const indexSql = await this.objects<{ sql: string }>(`SELECT sql FROM ${master} WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, [table])
    return {
      schema,
      table,
      type: obj.type === 'view' ? 'VIEW' : 'BASE TABLE',
      engine: null,
      rowsEstimate: null,
      comment: '',
      editDisabledReason: this.cfg.readOnly ? 'This SQLite connection is read-only' : undefined,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: !c.notnull,
        key: c.pk > 0 ? 'PRI' : '',
        default: c.dflt_value,
        extra: c.hidden === 2 || c.hidden === 3 ? 'GENERATED' : '',
        comment: ''
      })),
      indexes: groupIndexes(indexRows),
      foreignKeys,
      ddl: [obj.sql ? `${obj.sql};` : '', ...indexSql.map((i) => `${i.sql};`)].filter(Boolean).join('\n\n')
    }
  }
}
