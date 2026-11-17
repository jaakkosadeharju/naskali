import type { CellValue, ExportFormat } from './types'

function csvCell(value: CellValue): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Query aliases can repeat. Reserve original names so generated suffixes never overwrite them. */
function jsonKeys(columns: string[]): string[] {
  const reserved = new Set(columns)
  const nextSuffix = new Map<string, number>()
  return columns.map((column) => {
    let suffix = nextSuffix.get(column)
    if (suffix === undefined) {
      nextSuffix.set(column, 2)
      return column
    }
    while (reserved.has(`${column}_${suffix}`)) suffix++
    const key = `${column}_${suffix}`
    reserved.add(key)
    nextSuffix.set(column, suffix + 1)
    return key
  })
}

function rowObject(keys: string[], row: CellValue[]): Record<string, CellValue> {
  return Object.fromEntries(keys.map((key, column) => [key, row[column]]))
}

export function exportSelectionAsJson(columns: string[], rows: CellValue[][]): string {
  const keys = jsonKeys(columns)
  const records = rows.map((row) => rowObject(keys, row))
  return JSON.stringify(records.length === 1 ? records[0] : records, null, 2)
}

export function* exportRows(format: ExportFormat, columns: string[], rows: CellValue[][]): Generator<string> {
  if (format === 'csv') {
    yield columns.map(csvCell).join(',') + '\r\n'
    for (const row of rows) yield row.map(csvCell).join(',') + '\r\n'
    return
  }

  const keys = jsonKeys(columns)
  yield '['
  for (const [index, row] of rows.entries()) {
    const record = rowObject(keys, row)
    yield (index === 0 ? '\n  ' : ',\n  ') + JSON.stringify(record)
  }
  yield rows.length ? '\n]\n' : ']\n'
}
