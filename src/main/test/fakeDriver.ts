import { DIALECTS, type Param } from '../dialect'
import type { Driver, Exec } from '../drivers/types'
import type { ColumnMeta } from '../tableQuery'
import type { DriverKind, TableDetails } from '../../shared/types'

type Column = Partial<TableDetails['columns'][number]> & { name: string }

/** Table details for tests: columns default to a nullable `int` that isn't a key. */
export function table(schema: string, name: string, columns: Column[], extra: Partial<TableDetails> = {}): TableDetails {
  return {
    schema,
    table: name,
    type: 'BASE TABLE',
    engine: null,
    rowsEstimate: null,
    comment: '',
    indexes: [],
    foreignKeys: [],
    ddl: '',
    ...extra,
    columns: columns.map((c) => ({ type: 'int', nullable: true, key: '', default: null, extra: '', comment: '', ...c }))
  }
}

export interface FakeDriver extends Driver {
  /** Every statement run inside a transaction, in order. */
  readonly executed: { text: string; params: Param[] }[]
  /** 'commit' or 'rollback' for each finished transaction. */
  readonly transactions: ('commit' | 'rollback')[]
  /** Affected-row count each exec returns, by call index (default 1). */
  affected: number[]
}

/** A Driver backed by canned table details; transactions record their statements. */
export function fakeDriver(tables: TableDetails[], kind: DriverKind = 'mysql'): FakeDriver {
  const find = (schema: string, name: string): TableDetails => {
    const t = tables.find((x) => x.schema === schema && x.table === name)
    if (!t) throw new Error(`Table not found: ${schema}.${name}`)
    return t
  }
  const unsupported = (): never => {
    throw new Error('not faked')
  }
  const driver: FakeDriver = {
    dialect: DIALECTS[kind],
    executed: [],
    transactions: [],
    affected: [],
    connect: unsupported,
    disconnect: async () => undefined,
    query: unsupported,
    cancel: async () => undefined,
    beginEditorTransaction: unsupported,
    endEditorTransaction: unsupported,
    editorTransactionStatus: async () => 'idle',
    currentSchema: async () => null,
    useSchema: unsupported,
    introspect: unsupported,
    selectRows: unsupported,
    tableDetails: async (schema, name) => find(schema, name),
    columnMeta: async (schema, name): Promise<ColumnMeta[]> =>
      find(schema, name).columns.map(({ name: n, type, key, extra, nullable }) => ({ name: n, type, key, extra, nullable })),
    inTransaction: async <T>(fn: (exec: Exec) => Promise<T>): Promise<T> => {
      const exec: Exec = async (text, params) => {
        driver.executed.push({ text, params })
        return driver.affected[driver.executed.length - 1] ?? 1
      }
      try {
        const result = await fn(exec)
        driver.transactions.push('commit')
        return result
      } catch (e) {
        driver.transactions.push('rollback')
        throw e
      }
    }
  }
  return driver
}
