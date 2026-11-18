// Rules for which tables/columns can be edited in the data view. Shared so the
// UI and the main process (which enforces them) agree.

export interface EditableColumnMeta {
  type: string // COLUMN_TYPE, e.g. "varchar(100)"
  extra: string // EXTRA, e.g. "auto_increment", "VIRTUAL GENERATED"
}

/** Binary/spatial values are shown as lossy text, and generated columns can't be written. */
export function isEditableColumn(c: EditableColumnMeta): boolean {
  return (
    // MySQL's DEFAULT_GENERATED describes a default expression on a writable column.
    !/\bGENERATED\b/i.test(c.extra) &&
    // Not round-trippable as text. (SQL Server's binary `timestamp` is reported as `rowversion`.)
    !/blob|binary|bytea|^image$|geometry|geography|point|linestring|polygon|hierarchyid|sql_variant|rowversion|^xml$/i.test(
      c.type
    )
  )
}

/** Rows are addressed by primary key; a binary PK can't round-trip through the UI. */
export function tableEditability(
  type: string,
  columns: (EditableColumnMeta & { key: string; name: string })[]
): { editable: true } | { editable: false; reason: string } {
  if (type !== 'BASE TABLE') return { editable: false, reason: 'Views are read-only' }
  const pk = columns.filter((c) => c.key === 'PRI')
  if (pk.length === 0) return { editable: false, reason: 'Read-only: table has no primary key' }
  if (pk.some((c) => /blob|binary|bytea/i.test(c.type))) {
    return { editable: false, reason: 'Read-only: binary primary key' }
  }
  return { editable: true }
}

/** Classifies SQL date/time types while excluding SQL Server's binary timestamp alias. */
export function temporalCellKind(type: string, sqlServer: boolean): 'date' | 'time' | 'timestamp' | undefined {
  const name = type.toLowerCase().trim()
  if (name.endsWith('[]')) return undefined
  if (name === 'date') return 'date'
  if (/^(?:time(?:[( ]|$)|timetz$)/.test(name)) return 'time'
  if (/^(?:datetime(?:2|offset)?|smalldatetime)(?:[( ]|$)/.test(name)) return 'timestamp'
  if (!sqlServer && /^(?:timestamp(?:[( ]|$)|timestamptz$)/.test(name)) return 'timestamp'
}
