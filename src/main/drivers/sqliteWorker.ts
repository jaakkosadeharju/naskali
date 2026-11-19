// One SQLite connection, run off Electron's main thread (node:sqlite is
// synchronous). Runs either as a worker thread (metadata connection) or as a
// child process (editor connection – killing the process is the only way to
// stop a running statement, as node:sqlite has no interrupt).
// Protocol: the parent posts { id, op, ... } and gets back
// { id, ok: true, value } or { id, ok: false, error }.
import { parentPort } from 'node:worker_threads'
import { constants, DatabaseSync } from 'node:sqlite'
import { SPLIT_RULES, splitStatements } from '../../shared/sqlSplit'
import { fieldsOf, type WorkerField } from './sqliteColumns'

type Value = null | number | bigint | string | Uint8Array

export type WorkerRequest =
  | { id: number; op: 'open'; file: string; readOnly: boolean }
  | { id: number; op: 'query'; sql: string; max: number }
  | { id: number; op: 'select'; sql: string; params: (Value | boolean)[] }
  | { id: number; op: 'exec'; sql: string; params: (Value | boolean)[] }
  | { id: number; op: 'script'; sql: string }
  | { id: number; op: 'close' }
  | { id: number; op: 'transactionStatus' }

export type QueryReply =
  | { kind: 'rows'; fields: WorkerField[]; rows: unknown[][]; truncated: boolean }
  | { kind: 'ok'; changes: number | null; lastInsertRowid: bigint | null }

let db: DatabaseSync | null = null

const bindable = (v: unknown): Value => (typeof v === 'boolean' ? (v ? 1 : 0) : (v as Value))

const SQLITE_TRIVIA = /^(?:[\t\n\f\r ;\uFEFF]+|--[^\n]*|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$))*/

function prepareEditorQuery(db: DatabaseSync, sql: string) {
  if (sql.includes('\0')) throw new Error('SQL cannot contain a NUL character')

  // Some pragmas take effect during prepare, so check them before calling SQLite.
  const firstToken = sql.replace(SQLITE_TRIVIA, '')
  if (/^(?:EXPLAIN\s+(?:QUERY\s+PLAN\s+)?)?PRAGMA\b/i.test(firstToken)) {
    const [pragma] = splitStatements(firstToken, SPLIT_RULES.sqlite)
    if (pragma && firstToken.slice(pragma.end).replace(SQLITE_TRIVIA, '') !== '') {
      throw new Error('Run one SQLite statement at a time')
    }
  }

  let firstAction: number | undefined
  db.setAuthorizer((action, table) => {
    // DDL writes SQLite's catalog. Only count a top-level write to a user table.
    firstAction ??= table?.startsWith('sqlite_') ? constants.SQLITE_OK : action
    return constants.SQLITE_OK
  })
  try {
    const stmt = db.prepare(sql)
    // SQLite itself identifies the first statement, including trigger bodies.
    const tail = sql.slice(stmt.sourceSQL.length)
    if (tail.replace(SQLITE_TRIVIA, '') !== '') {
      throw new Error('Run one SQLite statement at a time')
    }
    stmt.setReadBigInts(true)
    return { stmt, action: firstAction }
  } finally {
    db.setAuthorizer(null)
  }
}

function handle(req: WorkerRequest): unknown {
  if (req.op === 'open') {
    db?.close()
    db = new DatabaseSync(req.file, { readOnly: req.readOnly, enableForeignKeyConstraints: true })
    // Wait instead of failing when the other connection (editor/metadata) holds a lock.
    db.exec('PRAGMA busy_timeout = 5000')
    return null
  }
  if (req.op === 'close') {
    db?.close()
    db = null
    return null
  }
  if (!db) throw new Error('Database is not open')

  switch (req.op) {
    case 'transactionStatus':
      return db.isTransaction
    case 'query': {
      const { stmt, action } = prepareEditorQuery(db, req.sql)
      if (stmt.columns().length === 0) {
        const insert = action === constants.SQLITE_INSERT
        const lastId = insert ? db.prepare('SELECT last_insert_rowid() AS id') : null
        lastId?.setReadBigInts(true)
        const previousId = lastId?.get()?.id
        const r = stmt.run()
        const changes = insert || action === constants.SQLITE_UPDATE || action === constants.SQLITE_DELETE
          ? Number(r.changes)
          : null
        // An ignored insert, an UPSERT update, or a WITHOUT ROWID table can leave an old ID behind.
        const lastInsertRowid = insert && changes && r.lastInsertRowid !== previousId ? BigInt(r.lastInsertRowid) : null
        return { kind: 'ok', changes, lastInsertRowid } satisfies QueryReply
      }
      stmt.setReturnArrays(true)
      const rows: unknown[][] = []
      let truncated = false
      for (const row of stmt.iterate()) {
        if (rows.length >= req.max) {
          truncated = true
          break
        }
        rows.push(row as unknown as unknown[])
      }
      // Stepping can recompile the statement after another connection changes the schema.
      return { kind: 'rows', fields: fieldsOf(stmt), rows, truncated } satisfies QueryReply
    }
    case 'select': {
      const stmt = db.prepare(req.sql)
      stmt.setReadBigInts(true)
      stmt.setReturnArrays(true)
      const rows = stmt.all(...req.params.map(bindable))
      return { fields: fieldsOf(stmt), rows }
    }
    case 'exec': {
      const stmt = db.prepare(req.sql)
      stmt.setReadBigInts(true)
      return Number(stmt.run(...req.params.map(bindable)).changes)
    }
    case 'script':
      db.exec(req.sql)
      return null
  }
}

// As a child process: exit when the parent goes away (crash, kill), so no orphan keeps the file open.
if (!parentPort) process.on('disconnect', () => process.exit(0))

const port = parentPort ?? {
  on: (_: 'message', cb: (m: WorkerRequest) => void) => process.on('message', cb),
  postMessage: (m: unknown) => process.send!(m)
}

port.on('message', (req: WorkerRequest) => {
  try {
    port.postMessage({ id: req.id, ok: true, value: handle(req) })
  } catch (e) {
    const err = e as Error & { code?: string }
    port.postMessage({ id: req.id, ok: false, error: err.message, code: err.code })
  }
})
