import type { ChangeSet, ChangeSummary, TableDataRequest, TableDataResult } from '../shared/types'
import { display, qualify, render, type Sql } from './dialect'
import { buildChangeStatements, buildWhere } from './tableQuery'
import type { Driver } from './drivers/types'

// Database-independent table operations on top of a Driver: paging/filtering
// the data view, previewing and applying row changes.

/** One page of a table's rows, filtered server-side (metadata connection). */
export async function tableData(driver: Driver, req: TableDataRequest): Promise<TableDataResult> {
  const d = driver.dialect
  const started = performance.now()
  const cols = await driver.columnMeta(req.schema, req.table)
  const where = buildWhere(d, req.filters, req.match, new Set(cols.map((c) => c.name)))
  const from = qualify(d, req.schema, req.table)
  // Order by primary key so paging is stable.
  const pk = cols.filter((c) => c.key === 'PRI').map((c) => d.quote(c.name))
  const limit = Math.min(Math.max(1, Math.floor(req.limit)), 10_000)
  const offset = Math.max(0, Math.floor(req.offset))

  const count: Sql = { text: `SELECT COUNT(*) AS total FROM ${from}${where.text}`, params: where.params }
  const select: Sql = { text: d.paginate(`SELECT * FROM ${from}${where.text}`, pk, limit, offset), params: where.params }

  const c = render(count, d)
  const total = Number((await driver.selectRows(c.text, c.params)).rows[0]?.[0] ?? 0)
  const s = render(select, d)
  const { fields, rows } = await driver.selectRows(s.text, s.params)
  return { fields, rows, total, offset, sql: display(select, d), elapsedMs: Math.round(performance.now() - started) }
}

export async function previewChanges(driver: Driver, cs: ChangeSet): Promise<string[]> {
  const stmts = buildChangeStatements(driver.dialect, cs, await driver.columnMeta(cs.schema, cs.table))
  return stmts.map((s) => display(s, driver.dialect) + ';')
}

/**
 * Applies a change set atomically (driver.inTransaction uses a dedicated
 * connection). Every statement must affect exactly one row – UPDATEs count
 * matched rows – otherwise everything is rolled back, e.g. when someone else
 * deleted the row meanwhile.
 */
export async function applyChanges(driver: Driver, cs: ChangeSet): Promise<ChangeSummary> {
  const d = driver.dialect
  const stmts = buildChangeStatements(d, cs, await driver.columnMeta(cs.schema, cs.table))
  await driver.inTransaction(async (exec) => {
    for (const s of stmts) {
      const r = render(s, d)
      let affected: number
      try {
        affected = await exec(r.text, r.params)
      } catch (e) {
        // Say which statement failed; inTransaction rolls back.
        const err = e as Error & { code?: string }
        throw Object.assign(new Error(`${err.message}. Nothing was saved.\n${display(s, d)}`), { code: err.code })
      }
      if (affected !== 1) {
        throw new Error(`No row matched – it may have been changed or deleted meanwhile. Nothing was saved.\n${display(s, d)}`)
      }
    }
  })
  const count = (k: string): number => stmts.filter((s) => s.kind === k).length
  return { deleted: count('delete'), updated: count('update'), inserted: count('insert') }
}
