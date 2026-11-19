import pg from 'pg'
import Cursor from 'pg-cursor'
import type { ConnectionInfo, QueryResult, ResultField, SchemaInfo, ServerConnectionConfig, TableDetails } from '../../shared/types'
import { DIALECTS, type Param } from '../dialect'
import type { ColumnMeta } from '../tableQuery'
import { MAX_ROWS, buildSchemaTree, generateDdl, groupForeignKeys, groupIndexes, normalise, type Driver, type Exec, type Rows } from './types'

// Returned as the server's text: dates/times keep their exact form (no JS Date
// timezone shifts), JSON keeps its formatting. int8/numeric are text already.
const RAW_TEXT_OIDS = new Set([
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1266, // timetz
  1186, // interval
  114, // json
  3802 // jsonb
])
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]) // int8 int2 int4 oid float4 float8 money numeric

const typeParsers = {
  getTypeParser: (oid: number, format?: string) =>
    RAW_TEXT_OIDS.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')
} as unknown as pg.CustomTypesConfig

/** Schemas hidden from the tree. */
const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg!_toast%' ESCAPE '!' AND n.nspname NOT LIKE 'pg!_temp!_%' ESCAPE '!'`
/** relkind → normalized table type: tables (incl. partitioned/foreign) and views (incl. materialized). */
const REL_TYPE = `CASE WHEN c.relkind IN ('v', 'm') THEN 'VIEW' ELSE 'BASE TABLE' END`
const REL_KINDS = `c.relkind IN ('r', 'p', 'f', 'v', 'm')`
/** attgenerated 's' = generated column; attidentity 'a' = GENERATED ALWAYS AS IDENTITY (not writable). */
const ATT_EXTRA = `CASE WHEN a.attgenerated = 's' THEN 'STORED GENERATED'
                        WHEN a.attidentity = 'a' THEN 'GENERATED ALWAYS AS IDENTITY'
                        WHEN a.attidentity = 'd' THEN 'identity' ELSE '' END`
const ATT_IS_PK = `EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey))`

/**
 * PostgreSQL: one connection per role – editor (user SQL, cancellable with
 * pg_cancel_backend), metadata (data view, introspection) and a short-lived
 * one per change transaction. Schemas are the connected database's schemas.
 */
export class PostgresDriver implements Driver {
  readonly dialect = DIALECTS.postgres
  private editor: pg.Client | null = null
  private meta: pg.Client | null = null
  private running = false
  /** OID → type name, loaded at connect (covers enums, domains, arrays…). */
  private typeNames = new Map<number, string>()

  constructor(private readonly cfg: ServerConnectionConfig) {}

  private async open(): Promise<pg.Client> {
    const client = new pg.Client({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database || undefined,
      ssl: this.cfg.ssl ? true : undefined,
      connectionTimeoutMillis: 10_000,
      application_name: 'Naskali',
      types: typeParsers
    })
    // A dropped connection must not crash the app; the next call reports the error.
    client.on('error', () => undefined)
    await client.connect()
    return client
  }

  async connect(): Promise<ConnectionInfo> {
    this.editor = await this.open()
    try {
      this.meta = await this.open()
    } catch (e) {
      await this.editor.end().catch(() => undefined)
      this.editor = null
      throw e
    }
    const types = await this.meta.query<{ oid: number; typname: string }>('SELECT oid::int AS oid, typname FROM pg_type')
    this.typeNames = new Map(types.rows.map((t) => [t.oid, t.typname]))
    const info = await this.meta.query<{ v: string; db: string; schema: string | null }>(
      `SELECT current_setting('server_version') AS v, current_database() AS db, current_schema() AS schema`
    )
    const { v, db, schema } = info.rows[0]
    return { driver: 'postgres', serverVersion: v.split(' ')[0], database: db, schema, capabilities: { switchSchema: true } }
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.editor?.end().catch(() => undefined), this.meta?.end().catch(() => undefined)])
    this.editor = this.meta = null
    this.running = false
  }

  private requireEditor(): pg.Client {
    if (!this.editor) throw new Error('Not connected')
    return this.editor
  }

  private requireMeta(): pg.Client {
    if (!this.meta) throw new Error('Not connected')
    return this.meta
  }

  private toFields(fields: pg.FieldDef[]): ResultField[] {
    return fields.map((f) => ({
      name: f.name,
      type: this.typeNames.get(f.dataTypeID) ?? `oid ${f.dataTypeID}`,
      numeric: NUMERIC_OIDS.has(f.dataTypeID)
    }))
  }

  async query(sql: string): Promise<QueryResult> {
    const editor = this.requireEditor()
    if (this.running) throw new Error('A query is already running')
    this.running = true
    const started = performance.now()
    try {
      // A cursor fetches at most MAX_ROWS + 1 rows instead of the whole result.
      const cursor = editor.query(new Cursor(sql, [], { rowMode: 'array' }))
      let read: { rows: unknown[][]; result: pg.QueryResult }
      try {
        read = await new Promise((resolve, reject) =>
          cursor.read(MAX_ROWS + 1, (err, rows, result) => (err ? reject(err) : resolve({ rows: rows as unknown[][], result })))
        )
      } finally {
        await new Promise<void>((resolve) => cursor.close(() => resolve()))
      }
      const { rows, result } = read
      const elapsedMs = Math.round(performance.now() - started)
      if (!result.fields?.length) {
        return { kind: 'ok', affectedRows: result.rowCount ?? 0, insertId: null, info: result.command ?? '', elapsedMs }
      }
      const truncated = rows.length > MAX_ROWS
      const kept = truncated ? rows.slice(0, MAX_ROWS) : rows
      const fields = this.toFields(result.fields)
      await this.addSources(editor, result.fields, fields)
      return {
        kind: 'rows',
        fields,
        rows: kept.map((r) => r.map(normalise)),
        rowCount: truncated ? null : kept.length,
        truncated,
        elapsedMs
      }
    } finally {
      this.running = false
    }
  }

  /**
   * Names the table column behind each result column: the protocol only gives
   * the table's OID and the column number (both 0 for expressions). Asked on the
   * connection that ran the query, after it finished. Columns stay without a
   * source when the lookup fails.
   */
  private async addSources(client: pg.Client, defs: pg.FieldDef[], fields: ResultField[]): Promise<void> {
    const wanted = defs.filter((f) => f.tableID && f.columnID > 0)
    if (wanted.length === 0) return
    try {
      const r = await client.query<{ oid: number; num: number; schema: string; table: string; column: string }>(
        `SELECT c.oid::int AS oid, a.attnum::int AS num, n.nspname AS schema, c.relname AS table, a.attname AS column
         FROM unnest($1::oid[], $2::int2[]) AS w(rel, num)
         JOIN pg_attribute a ON a.attrelid = w.rel AND a.attnum = w.num
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace`,
        [wanted.map((f) => f.tableID), wanted.map((f) => f.columnID)]
      )
      const byKey = new Map(r.rows.map((row) => [`${row.oid}:${row.num}`, row]))
      defs.forEach((def, i) => {
        const hit = byKey.get(`${def.tableID}:${def.columnID}`)
        if (hit) fields[i].source = { schema: hit.schema, table: hit.table, column: hit.column }
      })
    } catch {
      // e.g. the session's transaction was aborted meanwhile: the result is just not editable.
    }
  }

  async cancel(): Promise<void> {
    if (!this.running || !this.editor) return
    const pid = (this.editor as unknown as { processID: number }).processID
    await this.requireMeta().query('SELECT pg_cancel_backend($1)', [pid])
  }

  async beginEditorTransaction(): Promise<void> {
    await this.requireEditor().query('BEGIN')
  }

  async endEditorTransaction(action: 'commit' | 'rollback'): Promise<void> {
    await this.requireEditor().query(action === 'commit' ? 'COMMIT' : 'ROLLBACK')
  }

  async editorTransactionStatus(): Promise<'active' | 'idle' | 'failed'> {
    const status = this.requireEditor().getTransactionStatus()
    if (status === 'T') return 'active'
    if (status === 'I') return 'idle'
    return 'failed'
  }

  async currentSchema(): Promise<string | null> {
    return (await this.requireEditor().query<{ s: string | null }>('SELECT current_schema() AS s')).rows[0].s
  }

  async useSchema(name: string): Promise<void> {
    if (this.running) throw new Error('A query is running')
    // Keep public reachable for unqualified names (extensions, shared tables).
    const path = name === 'public' ? this.dialect.quote(name) : `${this.dialect.quote(name)}, public`
    await this.requireEditor().query(`SET search_path TO ${path}`)
  }

  async selectRows(sql: string, params: Param[]): Promise<Rows> {
    const r = await this.requireMeta().query({ text: sql, values: params, rowMode: 'array' })
    return { fields: this.toFields(r.fields), rows: (r.rows as unknown[][]).map((row) => row.map(normalise)) }
  }

  async inTransaction<T>(fn: (exec: Exec) => Promise<T>): Promise<T> {
    const client = await this.open()
    try {
      await client.query('BEGIN')
      // rowCount for UPDATE counts matched rows, also when the value doesn't change.
      const result = await fn(async (sql, params) => (await client.query(sql, params)).rowCount ?? 0)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  private async objects<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.requireMeta().query<T>(sql, params)).rows
  }

  /** The relation's columns via pg_attribute (format_type gives e.g. "character varying(100)"). */
  private async attributes(schema: string, table: string) {
    return this.objects<{ name: string; type: string; nullable: boolean; pk: boolean; def: string | null; extra: string; comment: string | null }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              ${ATT_IS_PK} AS pk, pg_get_expr(d.adbin, d.adrelid) AS def, ${ATT_EXTRA} AS extra,
              col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND ${REL_KINDS} AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table]
    )
  }

  async columnMeta(schema: string, table: string): Promise<ColumnMeta[]> {
    const cols = await this.attributes(schema, table)
    if (cols.length === 0) throw new Error(`Table not found: ${schema}.${table}`)
    return cols.map((c) => ({ name: c.name, type: c.type, key: c.pk ? 'PRI' : '', extra: c.extra, nullable: c.nullable, default: c.def }))
  }

  async introspect(): Promise<SchemaInfo[]> {
    const schemas = await this.objects<{ name: string }>(`SELECT n.nspname AS name FROM pg_namespace n WHERE ${SYSTEM_SCHEMA_FILTER} ORDER BY 1`)
    const tables = await this.objects<{ schema: string; table: string; type: string }>(
      `SELECT n.nspname AS schema, c.relname AS table, ${REL_TYPE} AS type
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${REL_KINDS} AND ${SYSTEM_SCHEMA_FILTER} AND NOT c.relispartition
       ORDER BY 1, 2`
    )
    const columns = await this.objects<{ schema: string; table: string; name: string; type: string; nullable: boolean; pk: boolean }>(
      `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable, ${ATT_IS_PK} AS pk
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${REL_KINDS} AND ${SYSTEM_SCHEMA_FILTER} AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY 1, 2, a.attnum`
    )
    const functions = await this.objects<{ schema: string; name: string }>(
      `SELECT n.nspname AS schema, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prokind IN ('f', 'w') AND ${SYSTEM_SCHEMA_FILTER}
       ORDER BY 1, 2`
    )
    return buildSchemaTree(
      schemas.map((s) => s.name),
      tables,
      columns.map((c) => ({ ...c, key: c.pk ? 'PRI' : '' })),
      functions
    )
  }

  async tableDetails(schema: string, table: string): Promise<TableDetails> {
    const [rel] = await this.objects<{ oid: number; kind: string; type: string; estimate: number; comment: string | null; viewdef: string | null }>(
      `SELECT c.oid::int AS oid, c.relkind AS kind, ${REL_TYPE} AS type, c.reltuples::float8 AS estimate,
              obj_description(c.oid, 'pg_class') AS comment,
              CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS viewdef
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND ${REL_KINDS}`,
      [schema, table]
    )
    if (!rel) throw new Error(`Table not found: ${schema}.${table}`)
    const cols = await this.attributes(schema, table)
    const indexRows = await this.objects<{ name: string; unique: boolean; type: string; column: string }>(
      `SELECT i.relname AS name, x.indisunique AS unique, am.amname AS type, pg_get_indexdef(x.indexrelid, k.n, true) AS column
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       CROSS JOIN LATERAL generate_series(1, x.indnkeyatts) AS k(n)
       WHERE x.indrelid = $1
       ORDER BY x.indisprimary DESC, i.relname, k.n`,
      [rel.oid]
    )
    const fkRows = await this.objects<{ name: string; column: string; refSchema: string; refTable: string; refColumn: string }>(
      `SELECT con.conname AS name, a.attname AS column, rn.nspname AS "refSchema", rc.relname AS "refTable", ra.attname AS "refColumn"
       FROM pg_constraint con
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       JOIN pg_class rc ON rc.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refnum
       WHERE con.contype = 'f' AND con.conrelid = $1
       ORDER BY con.conname, k.ord`,
      [rel.oid]
    )
    const details = {
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        key: c.pk ? 'PRI' : '',
        default: c.def,
        extra: c.extra,
        comment: c.comment ?? ''
      })),
      indexes: groupIndexes(indexRows),
      foreignKeys: groupForeignKeys(fkRows)
    }
    const q = (s: string): string => this.dialect.quote(s)
    const ddl =
      rel.viewdef !== null
        ? `CREATE ${rel.kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${q(schema)}.${q(table)} AS\n${rel.viewdef}`
        : generateDdl(this.dialect, schema, table, details)
    return {
      schema,
      table,
      type: rel.type,
      engine: null,
      rowsEstimate: rel.estimate >= 0 ? Math.round(rel.estimate) : null,
      comment: rel.comment ?? '',
      ...details,
      ddl
    }
  }
}
