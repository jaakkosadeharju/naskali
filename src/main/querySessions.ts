import type { Driver } from './drivers/types'
import type { EditorTransactionState, QueryResult } from '../shared/types'
import { maskSql, SPLIT_RULES, splitStatements } from '../shared/sqlSplit'

interface QuerySession {
  driver: Driver
  ready: Promise<void>
  schemaOverride?: string
  run?: { cancelled: boolean; executing: boolean; done: Promise<void>; cancellation?: Promise<void> }
  control?: Promise<EditorTransactionState | null>
  transaction?: EditorTransactionState
}

/** Keeps each tab's editor connection and SQL session state for the life of the tab. */
export class QuerySessions {
  private readonly tabs = new Map<string, QuerySession>()
  private schemaOverride?: string

  constructor(private readonly create: () => Driver) {}

  useSchema(name: string): void {
    this.schemaOverride = name
    for (const session of this.tabs.values()) session.schemaOverride = name
  }

  private session(id: string): QuerySession {
    let session = this.tabs.get(id)
    if (!session) {
      const driver = this.create()
      const ready = driver.connect().then(() => {}, async (error) => {
        if (this.tabs.get(id)?.ready === ready) this.tabs.delete(id)
        await driver.disconnect().catch(() => {})
        throw error
      })
      session = { driver, ready, schemaOverride: this.schemaOverride }
      this.tabs.set(id, session)
    }
    return session
  }

  private async applySchema(session: QuerySession): Promise<void> {
    const schema = session.schemaOverride
    if (schema === undefined || session.transaction) return
    await session.driver.useSchema(schema)
    if (session.schemaOverride === schema) session.schemaOverride = undefined
  }

  private async refreshTransaction(session: QuerySession): Promise<void> {
    if (!session.transaction) return
    const status = await session.driver.editorTransactionStatus().catch(() => 'failed')
    if (status === 'idle') session.transaction = undefined
    else session.transaction.rollbackOnly = status === 'failed'
  }

  async transaction(id: string, action: 'begin' | 'commit' | 'rollback' | 'status'): Promise<EditorTransactionState | null> {
    if (action === 'status') return this.tabs.get(id)?.transaction ?? null
    const session = action === 'begin' ? this.session(id) : this.tabs.get(id)
    if (!session) throw new Error('No active transaction')
    if (session.run || session.control) throw new Error('This tab is busy')
    if (action === 'begin' && session.transaction) throw new Error('A transaction is already open')
    if (action !== 'begin' && !session.transaction) throw new Error('No active transaction')
    const control = (async () => {
      await session.ready
      if (action === 'begin') {
        await this.applySchema(session)
        if (await session.driver.editorTransactionStatus() !== 'idle') throw new Error('End the existing SQL transaction first')
        await session.driver.beginEditorTransaction()
        session.transaction = { statements: 0, rollbackOnly: false }
      } else {
        await this.refreshTransaction(session)
        if (!session.transaction) throw new Error('The transaction has already ended')
        if (action === 'commit' && session.transaction.rollbackOnly) throw new Error('This transaction must be rolled back')
        try {
          await session.driver.endEditorTransaction(action)
          session.transaction = undefined
        } catch (error) {
          await this.refreshTransaction(session)
          throw error
        }
      }
      return session.transaction ?? null
    })()
    session.control = control
    try {
      return await control
    } finally {
      session.control = undefined
    }
  }

  async query(id: string, sql: string): Promise<{ result: QueryResult; schema: string | null }> {
    const session = this.session(id)
    if (session.run) throw new Error('A query is already running in this tab')
    if (session.control) throw new Error('A transaction operation is in progress')
    if (session.transaction?.rollbackOnly) throw new Error('This transaction must be rolled back')
    const transaction = session.transaction
    const rules = SPLIT_RULES[session.driver.dialect.kind]
    const statements = transaction ? splitStatements(sql, rules) : []
    if (statements.some(({ text }) => {
      const code = maskSql(text, rules).trimStart()
      const begin = session.driver.dialect.kind === 'mssql' ? /^BEGIN\s+(?:DISTRIBUTED\s+)?TRAN(?:SACTION)?\b/i : /^BEGIN\b/i
      return begin.test(code) ||
        /^(?:START\s+TRANSACTION|COMMIT|ROLLBACK|ABORT|END\b\s*(?:TRANSACTION|WORK)?\s*$|PREPARE\s+TRANSACTION|SET\s+(?:SESSION\s+)?(?:AUTOCOMMIT|IMPLICIT_TRANSACTIONS))\b/i.test(code.trimEnd())
    })) throw new Error('Use the transaction controls to commit or roll back')
    if (session.driver.dialect.kind === 'mysql' && statements.some(({ text }) =>
      /^(?:ALTER|CREATE|DROP|TRUNCATE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|ANALYZE|OPTIMIZE|REPAIR)\b/i.test(maskSql(text, rules).trimStart())
    )) throw new Error('This MySQL statement can commit implicitly. End the transaction before running it.')
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    const run: NonNullable<QuerySession['run']> = { cancelled: false, executing: false, done }
    session.run = run
    try {
      await session.ready
      if (!run.cancelled) await this.applySchema(session)
      if (run.cancelled) throw new Error('Query cancelled')
      run.executing = true
      const result = await session.driver.query(sql)
      if (transaction) transaction.statements += statements.length
      run.executing = false
      await run.cancellation?.catch(() => {})
      return { result, schema: await session.driver.currentSchema() }
    } finally {
      await run.cancellation?.catch(() => {})
      await this.refreshTransaction(session)
      session.run = undefined
      finished()
    }
  }

  async cancel(id: string): Promise<void> {
    const session = this.tabs.get(id)
    const run = session?.run
    if (!session || !run) return
    run.cancelled = true
    if (run.executing) run.cancellation ??= session.driver.cancel()
    await run.cancellation
  }

  async close(id: string): Promise<void> {
    const session = this.tabs.get(id)
    if (!session) return
    const cancellation = this.cancel(id)
    this.tabs.delete(id)
    await cancellation.catch(() => {})
    await session.run?.done
    await session.control?.catch(() => {})
    await session.ready.then(() => session.driver.disconnect(), () => {})
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.tabs.keys()].map((id) => this.close(id)))
  }
}
