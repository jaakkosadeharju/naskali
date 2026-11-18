import type { ColumnSource, ResultEditInfo, ResultEditTable, ResultField, TableDetails } from '../shared/types'
import { isEditableColumn, tableEditability } from '../shared/editing'
import { SPLIT_RULES, isPlainSelect } from '../shared/sqlSplit'
import type { Driver } from './drivers/types'
import { queryShape } from './queryShape'

// Decides which parts of a query result can be edited. A result field is
// editable when the driver reports the table column it was read from, that
// table passes the table view's editing rules, and the table's whole primary key
// is in the result, so every row can be addressed exactly like in the table view.
// The table must also be read just once, straight by its name: drivers don't say
// which reference to a table a column came through (self-joins, views).

const CALCULATED = 'Calculated column'
const NOT_EDITABLE = 'Generated or binary column'

interface SourceTable {
  schema: string
  table: string
  /** Result fields read from this table, in result order. */
  fields: { index: number; field: ResultField; source: ColumnSource }[]
}

function groupBySourceTable(fields: ResultField[]): SourceTable[] {
  const tables = new Map<string, SourceTable>()
  fields.forEach((field, index) => {
    const source = field.source
    if (!source) return
    const id = JSON.stringify([source.schema, source.table])
    const entry = tables.get(id) ?? { schema: source.schema, table: source.table, fields: [] }
    entry.fields.push({ index, field, source })
    tables.set(id, entry)
  })
  return [...tables.values()]
}

/** The editable table, or why the whole table is read-only. */
function resolveTable(src: SourceTable, details: TableDetails, readOnly: Record<number, string>): ResultEditTable | string {
  if (details.editDisabledReason) return details.editDisabledReason
  const editability = tableEditability(details.type, details.columns)
  if (!editability.editable) return editability.reason

  const columnNames = src.fields.map((f) => f.source.column)
  if (new Set(columnNames).size !== columnNames.length) return `Read-only: ${src.table} appears more than once in the result`

  const fieldOf = new Map(src.fields.map((f) => [f.source.column, f]))
  const pk = details.columns.filter((c) => c.key === 'PRI')
  const missing = pk.filter((c) => !fieldOf.has(c.name)).map((c) => c.name)
  if (missing.length) return `Read-only: include ${missing.join(', ')} to edit ${src.table}`
  if (pk.some((c) => fieldOf.get(c.name)!.field.unsafeKey)) {
    return `Read-only: ${src.table} has primary keys that cannot be edited safely`
  }

  const byName = new Map(details.columns.map((c) => [c.name, c]))
  const columns: ResultEditTable['columns'] = []
  for (const { index, source } of src.fields) {
    const column = byName.get(source.column)
    if (column && isEditableColumn(column)) columns.push({ field: index, column: column.name, nullable: column.nullable })
    else readOnly[index] = column ? NOT_EDITABLE : `Unknown column ${source.column}`
  }
  return {
    schema: src.schema,
    table: src.table,
    key: pk.map((c) => ({ column: c.name, field: fieldOf.get(c.name)!.index })),
    columns
  }
}

/** What can be edited in the single result set `fields` produced by `sql`. */
export async function resultEditInfo(driver: Pick<Driver, 'dialect' | 'tableDetails'>, sql: string, fields: ResultField[]): Promise<ResultEditInfo> {
  const rules = SPLIT_RULES[driver.dialect.kind]
  // Saving re-runs the query, so it must be one statement that only reads.
  if (!isPlainSelect(sql, rules)) {
    return { tables: [], readOnly: {}, reason: 'Only results of a single SELECT statement can be edited' }
  }
  const shape = queryShape(sql, rules)
  // SQLite names the leftmost SELECT's table for every row of a compound query.
  if (shape.setOperation) return { tables: [], readOnly: {}, reason: 'Read-only: results of UNION, INTERSECT or EXCEPT cannot be edited' }
  const reusedCte = [...shape.ctes].find((name) => (shape.reads.get(name) ?? 0) > 1)
  if (reusedCte) return { tables: [], readOnly: {}, reason: `Read-only: ${reusedCte} is used more than once in the query` }

  const readOnly: Record<number, string> = {}
  fields.forEach((f, i) => {
    if (!f.source) readOnly[i] = CALCULATED
  })

  const tables: ResultEditTable[] = []
  const reasons: string[] = []
  for (const src of groupBySourceTable(fields)) {
    let resolved: ResultEditTable | string
    const reads = shape.reads.get(src.table.toLowerCase()) ?? 0
    if (reads > 1) resolved = `Read-only: ${src.table} is read more than once in the query`
    else if (reads === 0) resolved = `Read-only: the query reads ${src.table} through a view`
    else {
      try {
        resolved = resolveTable(src, await driver.tableDetails(src.schema, src.table), readOnly)
      } catch (e) {
        resolved = e instanceof Error ? e.message : String(e)
      }
    }
    if (typeof resolved === 'string') {
      reasons.push(resolved)
      for (const f of src.fields) readOnly[f.index] = resolved
    } else tables.push(resolved)
  }

  if (tables.length) return { tables, readOnly }
  return { tables, readOnly, reason: reasons[0] ?? 'Read-only: no column comes straight from a table' }
}
