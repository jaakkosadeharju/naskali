import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TableFilter } from '../workspaceStore'
import { FilterBar, newFilter, type DraftFilter } from './FilterBar'
import { ExportRows } from './ExportRows'
import { ResultsGrid, type CellLinks } from './ResultsGrid'
import { TableSchemaView } from './TableSchemaView'
import { SqlPreviewModal } from './SqlPreviewModal'
import { PendingBar, summarize } from './PendingBar'
import { useRowEditing } from '../useRowEditing'
import type { EditTarget } from '../rowEditing'
import { isEditableColumn, tableEditability } from '../../../shared/editing'
import type { RowFilter, TableDataResult, TableDetails } from '../../../shared/types'

const PAGE_SIZE = 500

export type TableViewMode = 'data' | 'schema'

interface Props {
  sqlite: boolean
  schema: string
  table: string
  view: TableViewMode
  onViewChange: (v: TableViewMode) => void
  onEditSchema?: () => void
  onOpenSql: (sql: string) => void
  /** Reports whether this tab has unsaved edits (so closing it can ask first). */
  onDirtyChange: (dirty: boolean) => void
  /** Filters applied when the tab opens (e.g. following a foreign key). */
  initialFilter?: TableFilter
  onFilterApply: (filter: TableFilter) => void
  /** Opens a referenced table filtered to the given row (foreign-key links). */
  onOpenReference: (schema: string, table: string, filters: RowFilter[]) => void
}

const strip = (fs: DraftFilter[]): RowFilter[] => fs.map(({ id, ...filter }) => filter)

export function TableView({ sqlite, schema, table, view, onViewChange, onEditSchema, onOpenSql, onDirtyChange, initialFilter, onFilterApply, onOpenReference }: Props): JSX.Element {
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)

  const [draft, setDraft] = useState<DraftFilter[]>(() => (initialFilter?.filters ?? []).map((f) => ({ ...newFilter(f.column), ...f })))
  const [match, setMatch] = useState<'all' | 'any'>(initialFilter?.match ?? 'all')
  const [applied, setApplied] = useState<TableFilter>(() => initialFilter ?? { filters: [], match: 'all' })
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<TableDataResult | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)

  const loadDetails = useCallback(async () => {
    const r = await window.api.tableDetails(schema, table)
    if (r.ok) {
      setDetails(r.value)
      setDetailsError(null)
    } else setDetailsError(r.error)
  }, [schema, table])

  const loadData = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    const r = await window.api.tableData({ schema, table, ...applied, offset, limit: PAGE_SIZE })
    if (id !== requestId.current) return // a newer request superseded this one
    setLoading(false)
    if (r.ok) {
      // Past the end (e.g. the last page's rows were just deleted): step back to the new last page.
      if (r.value.rows.length === 0 && r.value.offset > 0 && r.value.total > 0) {
        setOffset(Math.floor((r.value.total - 1) / PAGE_SIZE) * PAGE_SIZE)
        return
      }
      setData(r.value)
      setDataError(null)
    } else setDataError(r.error)
  }, [schema, table, applied, offset])

  useEffect(() => {
    void loadDetails()
  }, [loadDetails])

  // Data is fetched lazily: only once the data view has been shown.
  const [dataWanted, setDataWanted] = useState(view === 'data')
  useEffect(() => {
    if (view === 'data') setDataWanted(true)
  }, [view])
  useEffect(() => {
    if (dataWanted) void loadData()
  }, [dataWanted, loadData])

  const apply = (): void => {
    const filter = { filters: strip(draft), match }
    setApplied(filter)
    onFilterApply(filter)
    setOffset(0)
  }
  const dirty = JSON.stringify({ filters: strip(draft), match }) !== JSON.stringify(applied)
  const refresh = (): void => {
    void loadDetails()
    if (dataWanted) void loadData()
  }

  // ---- Editing -------------------------------------------------------------
  // Staged changes are keyed by primary key, so they survive paging and refreshes.
  const [selectedRows, setSelectedRows] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)

  const editDisabledReason = details?.editDisabledReason ?? data?.editDisabledReason
  const editability = editDisabledReason
    ? { editable: false as const, reason: editDisabledReason }
    : details ? tableEditability(details.type, details.columns) : null
  const fields = data?.fields

  const pkFields = useMemo(() => {
    if (!details || !fields) return null
    return details.columns.filter((c) => c.key === 'PRI').map((c) => ({ column: c.name, field: fields.findIndex((f) => f.name === c.name) }))
  }, [details, fields])

  // The table as the grid's edit target; its rows are addressed by the primary key, which the page must hold.
  const editable = !!editability?.editable
  const targets = useMemo<EditTarget[]>(() => {
    if (!details || !fields || !pkFields || !editable || pkFields.some((k) => k.field < 0)) return []
    const byName = new Map(details.columns.map((c) => [c.name, c]))
    const columns = fields.flatMap((f, field) => {
      const c = byName.get(f.name)
      return c && isEditableColumn(c) ? [{ field, column: c.name, nullable: c.nullable, hasDefault: c.default !== null }] : []
    })
    return [{ schema, table, key: pkFields, columns }]
  }, [details, fields, pkFields, editable, schema, table])

  const touch = useCallback((): void => {
    setSavedMsg(null)
    setSaveError(null)
  }, [])
  const edits = useRowEditing({ fields, rows: data?.rows, targets, allowInsert: true, allowDelete: true, onStage: touch })
  const { displayRows, editing, changeCount, newRowCount, isDeleted } = edits

  useEffect(() => {
    onDirtyChange(changeCount > 0)
  }, [changeCount, onDirtyChange])

  // For the value inspector: real column types, and rows described by primary key.
  const columnTypes = useMemo(() => {
    if (!details || !fields) return undefined
    const byName = new Map(details.columns.map((c) => [c.name, c.type]))
    return fields.map((f) => byName.get(f.name) ?? f.type)
  }, [details, fields])
  // Foreign-key cells link to the referenced row (all columns of a composite key must be non-NULL).
  const cellLinks = useMemo<CellLinks | undefined>(() => {
    if (!details || !fields || details.foreignKeys.length === 0) return undefined
    const index = new Map(fields.map((f, i) => [f.name, i]))
    const fkByCol = new Map<number, TableDetails['foreignKeys'][number]>()
    for (const fk of details.foreignKeys) {
      if (fk.columns.some((c) => !index.has(c))) continue
      for (const c of fk.columns) if (!fkByCol.has(index.get(c)!)) fkByCol.set(index.get(c)!, fk)
    }
    if (fkByCol.size === 0) return undefined
    const filtersFor = (row: number, col: number): RowFilter[] | null => {
      const fk = fkByCol.get(col)
      const r = displayRows[row]
      if (!fk || !r) return null
      const values = fk.columns.map((c) => r[index.get(c)!])
      if (values.some((v) => v === null)) return null
      return fk.refColumns.map((rc, i) => ({ column: rc, op: '=', value: String(values[i]) }))
    }
    const target = (col: number): string => {
      const fk = fkByCol.get(col)!
      return fk.refSchema === schema ? fk.refTable : `${fk.refSchema}.${fk.refTable}`
    }
    return {
      has: (row, col) => filtersFor(row, col) !== null,
      label: (row, col) => `${target(col)} where ${filtersFor(row, col)!.map((f) => `${f.column} = ${f.value}`).join(' and ')}`,
      open: (row, col) => {
        const filters = filtersFor(row, col)
        const fk = fkByCol.get(col)
        if (filters && fk) onOpenReference(fk.refSchema, fk.refTable, filters)
      }
    }
  }, [details, fields, displayRows, schema, onOpenReference])

  const describeRow = useCallback(
    (row: number): string => {
      if (row < newRowCount) return 'new row'
      const r = data?.rows[row - newRowCount]
      if (!r || !pkFields?.length || pkFields.some((p) => p.field < 0)) return `row ${row + 1}`
      const pk = pkFields.map((p) => `${p.column} = ${r[p.field]}`).join(', ')
      return isDeleted(row) ? `${pk} (marked for deletion)` : pk
    },
    [newRowCount, data, pkFields, isDeleted]
  )

  const viewSql = async (): Promise<void> => {
    const r = await window.api.previewChanges(edits.changeSets())
    if (r.ok) setPreview(r.value)
    else setSaveError(r.error)
  }
  const discard = (): void => {
    edits.discard()
    setSaveError(null)
  }
  const accept = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    const r = await window.api.applyChanges(edits.changeSets())
    setSaving(false)
    if (!r.ok) {
      setSaveError(r.error)
      return
    }
    discard()
    setSavedMsg(`Saved: ${summarize(r.value)}`)
    void loadData()
  }

  const total = data?.total ?? 0
  const lastOffset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE)

  return (
    <div className="table-view">
      <div className="table-header">
        <h1 className="table-title" title={`${schema}.${table}`}>
          <span>{schema}</span>
          {table}
        </h1>
        <div className="segmented">
          <button className={view === 'data' ? 'active' : ''} aria-pressed={view === 'data'} onClick={() => onViewChange('data')}>
            Data
          </button>
          <button className={view === 'schema' ? 'active' : ''} aria-pressed={view === 'schema'} onClick={() => onViewChange('schema')}>
            Schema
          </button>
        </div>
        {view === 'data' && editability && editability.editable && (
          <>
            <button onClick={edits.addRow} disabled={!editing} title="Insert a new row (shown at the top)">
              + Add row
            </button>
            <button
              onClick={() => edits.deleteRows(selectedRows)}
              disabled={!editing || selectedRows.length === 0}
              title="Mark selected rows for deletion (select rows by clicking their numbers). Again to unmark."
            >
              − Delete rows{selectedRows.length > 0 ? ` (${selectedRows.length})` : ''}
            </button>
            <span className="muted edit-hint">Double-click a cell to edit · Delete key: cells → NULL, selected rows → delete</span>
          </>
        )}
        {view === 'data' && editability && !editability.editable && <span className="muted edit-hint">{editability.reason}</span>}
        <div className="spacer" />
        {view === 'data' && data && !dataError && (
          <ExportRows fields={data.fields} rows={data.rows} name={`${schema}.${table}-page-${Math.floor(data.offset / PAGE_SIZE) + 1}`} page disabled={loading || saving} />
        )}
        <button onClick={refresh} title="Reload (pending edits are kept)">
          ⟳ Refresh
        </button>
      </div>

      {view === 'schema' ? (
        <div className="table-body scroll">
          {detailsError && <pre className="error-panel">{detailsError}</pre>}
          {details ? <TableSchemaView details={details} onEditSchema={onEditSchema} onOpenSql={onOpenSql} /> : !detailsError && <div className="placeholder">Loading…</div>}
        </div>
      ) : (
        <>
          <FilterBar
            sqlite={sqlite}
            columns={details?.columns.map((c) => c.name) ?? []}
            filters={draft}
            match={match}
            dirty={dirty}
            onChange={setDraft}
            onMatchChange={setMatch}
            onApply={apply}
          />
          <div className="table-body">
            {dataError ? (
              <pre className="error-panel">{dataError}</pre>
            ) : data ? (
              <ResultsGrid fields={data.fields} rows={displayRows} editing={editing} onSelectedRowsChange={setSelectedRows}
                selectionResetKey={newRowCount}
                sourceLabel={`${schema}.${table}`}
                columnTypes={columnTypes}
                describeRow={describeRow}
                cellLinks={cellLinks}
              />
            ) : (
              <div className="placeholder">Loading…</div>
            )}
          </div>
          <PendingBar
            counts={edits.counts}
            error={saveError}
            saving={saving}
            onViewSql={viewSql}
            onCancel={discard}
            onAccept={accept}
            onDismissError={() => setSaveError(null)}
          />
          <div className="pager">
            <button onClick={() => setOffset(0)} disabled={loading || offset === 0} title="First page">
              ⏮
            </button>
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={loading || offset === 0}>
              ◀
            </button>
            <span>
              {total === 0
                ? 'No rows'
                : `${(data!.offset + 1).toLocaleString()}–${(data!.offset + data!.rows.length).toLocaleString()} of ${total.toLocaleString()}`}
              {applied.filters.length > 0 && ' (filtered)'}
            </span>
            <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={loading || offset >= lastOffset}>
              ▶
            </button>
            <button onClick={() => setOffset(lastOffset)} disabled={loading || offset >= lastOffset} title="Last page">
              ⏭
            </button>
            {loading && <span className="muted">Loading…</span>}
            {data && !loading && <span className="muted">{data.elapsedMs} ms</span>}
            {savedMsg && <span className="saved-msg">✓ {savedMsg}</span>}
            <div className="spacer" />
            {data && (
              <>
                <code className="sql-preview" title={data.sql}>
                  {data.sql}
                </code>
                <button className="small" onClick={() => onOpenSql(data.sql)}>
                  Open in editor
                </button>
              </>
            )}
          </div>
        </>
      )}
      {preview && (
        <SqlPreviewModal
          title={`Pending changes – ${schema}.${table}`}
          statements={preview}
          onClose={() => setPreview(null)}
          onOpenInEditor={onOpenSql}
        />
      )}
    </div>
  )
}
