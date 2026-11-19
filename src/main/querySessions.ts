import type { Driver } from './drivers/types'
import type { QueryResult } from '../shared/types'

interface QuerySession {
  driver: Driver
  ready: Promise<void>
  schemaOverride?: string
  run?: { cancelled: boolean; executing: boolean; cancellation?: Promise<void> }
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

  async query(id: string, sql: string): Promise<{ result: QueryResult; schema: string | null }> {
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
    if (session.run) throw new Error('A query is already running in this tab')
    const run: NonNullable<QuerySession['run']> = { cancelled: false, executing: false }
    session.run = run
    try {
      await session.ready
      const schema = session.schemaOverride
      if (!run.cancelled && schema !== undefined) {
        await session.driver.useSchema(schema)
        if (session.schemaOverride === schema) session.schemaOverride = undefined
      }
      if (run.cancelled) throw new Error('Query cancelled')
      run.executing = true
      const result = await session.driver.query(sql)
      run.executing = false
      await run.cancellation?.catch(() => {})
      return { result, schema: await session.driver.currentSchema() }
    } finally {
      await run.cancellation?.catch(() => {})
      session.run = undefined
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
    await session.ready.then(() => session.driver.disconnect(), () => {})
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.tabs.keys()].map((id) => this.close(id)))
  }
}
