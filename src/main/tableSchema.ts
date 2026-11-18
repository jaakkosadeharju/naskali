import type { CreateTableAction, NewTableColumn, TableAction } from '../shared/types'
import type { SqlDialect } from './dialect'
import type { Driver } from './drivers/types'

// Keep column types separate from SQL clauses. Type names are entered as SQL
// type specifications, while table and column names are always identifiers.
const COLUMN_TYPE = /^(?:(?:SMALLINT|INT|INTEGER|BIGINT|TINYINT|MEDIUMINT|REAL|FLOAT|DOUBLE(?: PRECISION)?|BIT|BOOL(?:EAN)?|NUMERIC|DECIMAL|DEC|MONEY|TEXT|N?CHAR|N?VARCHAR|CHARACTER(?: VARYING)?|BINARY|VARBINARY|BLOB|BYTEA|DATE|TIME(?:STAMP)?|DATETIME2?|DATETIMEOFFSET|JSONB?|UUID|UNIQUEIDENTIFIER|XML)(?:\((?:\d+(?:\s*,\s*\d+)?|MAX)\))?)(?: (?:WITH(?:OUT)? TIME ZONE|UNSIGNED))?$/i

function identifier(d: SqlDialect, name: string): string {
  if (!name.trim()) throw new Error('Table, schema and column names are required')
  return d.quote(name)
}

function columnDefinition(d: SqlDialect, column: Omit<NewTableColumn, 'primaryKey'>): string {
  const type = column.type.trim()
  if (!COLUMN_TYPE.test(type)) throw new Error(`Unsupported type specification for ${column.name}: ${type}`)
  return `${identifier(d, column.name)} ${type}${column.nullable ? ' NULL' : ' NOT NULL'}`
}

export function createTableSql(d: SqlDialect, action: CreateTableAction): string {
  const quote = (name: string): string => identifier(d, name)
  const target = `${quote(action.schema)}.${quote(action.table)}`
  if (!action.columns.length) throw new Error('Add at least one column')
  const names = new Set(action.columns.map((column) => column.name))
  if (names.size !== action.columns.length) throw new Error('Column names must be unique')
  const lines = action.columns.map((column) => columnDefinition(d, { ...column, nullable: !column.primaryKey && column.nullable }))
  const primaryKey = action.columns.filter((column) => column.primaryKey).map((column) => quote(column.name))
  if (primaryKey.length) lines.push(`PRIMARY KEY (${primaryKey.join(', ')})`)

  for (const fk of action.foreignKeys) {
    if (!fk.columns.length || fk.columns.length !== fk.refColumns.length || fk.columns.some((name) => !names.has(name))) {
      throw new Error('Each foreign key needs matching local and referenced columns')
    }
    if (new Set(fk.columns).size !== fk.columns.length || new Set(fk.refColumns).size !== fk.refColumns.length) {
      throw new Error('Each column can only appear once in a foreign key')
    }
    if (d.kind === 'sqlite' && fk.refSchema !== action.schema) throw new Error('SQLite foreign keys must reference the same schema')
    // SQLite requires an unqualified table name inside REFERENCES.
    const parent = d.kind === 'sqlite' ? quote(fk.refTable) : `${quote(fk.refSchema)}.${quote(fk.refTable)}`
    lines.push(`FOREIGN KEY (${fk.columns.map(quote).join(', ')}) REFERENCES ${parent} (${fk.refColumns.map(quote).join(', ')})`)
  }
  return `CREATE TABLE ${target} (\n  ${lines.join(',\n  ')}\n);`
}

export async function changeTable(driver: Driver, action: TableAction): Promise<void> {
  const d = driver.dialect
  const quote = (name: string): string => identifier(d, name)
  const target = `${quote(action.schema)}.${quote(action.table)}`

  if (action.kind !== 'create') {
    const details = await driver.tableDetails(action.schema, action.table)
    if (details.type !== 'BASE TABLE') throw new Error('Select a base table to make this change')
  }

  let sql: string
  let params: string[] = []
  switch (action.kind) {
    case 'create':
      sql = createTableSql(d, action)
      break
    case 'addColumn':
      sql = `ALTER TABLE ${target} ADD ${columnDefinition(d, action.column)}`
      break
    case 'renameColumn': {
      const column = quote(action.column)
      const name = quote(action.name)
      if (d.kind === 'mssql') {
        sql = "EXEC sys.sp_rename @p1, @p2, N'COLUMN'"
        params = [`${target}.${column}`, action.name]
      } else {
        sql = `ALTER TABLE ${target} RENAME COLUMN ${column} TO ${name}`
      }
      break
    }
    case 'dropColumn':
      sql = `ALTER TABLE ${target} DROP COLUMN ${quote(action.column)}`
      break
    case 'drop':
      sql = `DROP TABLE ${target}`
      break
    case 'truncate':
      sql = d.kind === 'sqlite' ? `DELETE FROM ${target}` : `TRUNCATE TABLE ${target}`
      break
    default:
      throw new Error('Unknown table action')
  }

  // One statement per action. MySQL DDL commits implicitly.
  await driver.inTransaction(async (exec) => { await exec(sql, params) })
}
