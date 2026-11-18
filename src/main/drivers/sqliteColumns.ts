import type { StatementSync } from 'node:sqlite'

// Result column facts SQLite gives about a prepared statement. Kept apart from
// sqliteWorker (which starts listening for messages when loaded) so it can be tested.

export interface WorkerField {
  name: string
  /** Declared column type, if the result column comes straight from a table column. */
  type: string | null
  /** The table column the result column is read from; absent for expressions. */
  source?: { database: string; table: string; column: string }
}

export function fieldsOf(stmt: StatementSync): WorkerField[] {
  return stmt.columns().map((c) => {
    const field: WorkerField = { name: c.name, type: c.type ?? null }
    if (c.database && c.table && c.column) field.source = { database: c.database, table: c.table, column: c.column }
    return field
  })
}
