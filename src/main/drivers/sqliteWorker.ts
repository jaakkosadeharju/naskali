// One SQLite connection, run off Electron's main thread (node:sqlite is
// synchronous). Runs either as a worker thread (metadata connection) or as a
// child process (editor connection – killing the process is the only way to
// stop a running statement, as node:sqlite has no interrupt).
// Protocol: the parent posts { id, op, ... } and gets back
// { id, ok: true, value } or { id, ok: false, error }.
import { parentPort } from 'node:worker_threads'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

type Value = null | number | bigint | string | Uint8Array

export interface WorkerField {
  name: string
  /** Declared column type, if the result column comes straight from a table column. */
  type: string | null
}

export type WorkerRequest =
  | { id: number; op: 'open'; file: string; readOnly: boolean }
  | { id: number; op: 'query'; sql: string; max: number }
  | { id: number; op: 'select'; sql: string; params: (Value | boolean)[] }
  | { id: number; op: 'exec'; sql: string; params: (Value | boolean)[] }
  | { id: number; op: 'script'; sql: string }
  | { id: number; op: 'close' }

export type QueryReply =
  | { kind: 'rows'; fields: WorkerField[]; rows: unknown[][]; truncated: boolean }
  | { kind: 'ok'; changes: number; lastInsertRowid: number }

let db: DatabaseSync | null = null

const bindable = (v: unknown): Value => (typeof v === 'boolean' ? (v ? 1 : 0) : (v as Value))

function fieldsOf(stmt: StatementSync): WorkerField[] {
  return stmt.columns().map((c) => ({ name: c.name, type: c.type ?? null }))
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
    case 'query': {
      const stmt = db.prepare(req.sql)
      const fields = fieldsOf(stmt)
      if (fields.length === 0) {
        const r = stmt.run()
        return { kind: 'ok', changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) } satisfies QueryReply
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
      return { kind: 'rows', fields, rows, truncated } satisfies QueryReply
    }
    case 'select': {
      const stmt = db.prepare(req.sql)
      stmt.setReturnArrays(true)
      return { fields: fieldsOf(stmt), rows: stmt.all(...req.params.map(bindable)) }
    }
    case 'exec':
      return Number(db.prepare(req.sql).run(...req.params.map(bindable)).changes)
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
