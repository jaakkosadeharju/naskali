import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterBar, type DraftFilter } from './FilterBar'
import { ResultsGrid, type GridEditing } from './ResultsGrid'
import { TableSchemaView } from './TableSchemaView'
import { SqlPreviewModal } from './SqlPreviewModal'
import { isEditableColumn, tableEditability } from '../../../shared/editing'
import type { CellValue, ChangeSet, RowFilter, TableDataResult, TableDetails } from '../../../shared/types'

const PAGE_SIZE = 500

export type TableViewMode = 'data' | 'schema'

interface Props {
  schema: string
  table: string
  view: TableViewMode
  onViewChange: (v: TableViewMode) => void
  onOpenSql: (sql: string) => void
  /** Reports whether this tab has unsaved edits (so closing it can ask first). */
  onDirtyChange: (dirty: boolean) => void
}

/** Edits to one row, keyed in `pending` by its original primary key values. */
interface PendingRow {
  key: Record<string, CellValue>
  set: Record<string, CellValue>
}

interface NewRow {
  id: number
  values: Record<string, CellValue>
}
let nextRowId = 1

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
function summarize(inserted: number, updated: number, deleted: number): string {
  const parts: string[] = []
  if (inserted) parts.push(`${plural(inserted, 'row')} added`)
  if (updated) parts.push(`${plural(updated, 'row')} updated`)
  if (deleted) parts.push(`${plural(deleted, 'row')} deleted`)
  return parts.join(', ') || 'nothing'
}

const sameValue = (a: CellValue, b: CellValue): boolean =>
  a === b || (a !== null && b !== null && String(a) === String(b))

interface Applied {
  filters: RowFilter[]
  match: 'all' | 'any'
}

const strip = (fs: DraftFilter[]): RowFilter[] => fs.map(({ column, op, value }) => ({ column, op, value }))

export function TableView({ schema, table, view, onViewChange, onOpenSql, onDirtyChange }: Props): JSX.Element {
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)

  const [draft, setDraft] = useState<DraftFilter[]>([])
  const [match, setMatch] = useState<'all' | 'any'>('all')
  const [applied, setApplied] = useState<Applied>({ filters: [], match: 'all' })
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
    setApplied({ filters: strip(draft), match })
    setOffset(0)
  }
  const dirty = JSON.stringify({ filters: strip(draft), match }) !== JSON.stringify(applied)
  const refresh = (): void => {
    void loadDetails()
    if (dataWanted) void loadData()
  }

  // ---- Editing -------------------------------------------------------------
  // Three kinds of pending change, all keyed so they survive paging/refresh:
  //  - updates: by the row's original PK (JSON) → changed columns
  //  - deletes: by the row's PK (JSON) → PK values
  //  - inserts: new rows shown above the loaded rows; only explicitly set columns
  const [pending, setPending] = useState<Map<string, PendingRow>>(new Map())
  const [deleted, setDeleted] = useState<Map<string, Record<string, CellValue>>>(new Map())
  const [inserts, setInserts] = useState<NewRow[]>([])
  const [selectedRows, setSelectedRows] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)

  const changeCount = pending.size + deleted.size + inserts.length
  useEffect(() => {
    onDirtyChange(changeCount > 0)
  }, [changeCount, onDirtyChange])

  const editability = details ? tableEditability(details.type, details.columns) : null
  const fields = data?.fields

  // Per-column facts for the current result, looked up by name in the table details.
  const colInfo = useMemo(() => {
    if (!details || !fields) return null
    const byName = new Map(details.columns.map((c) => [c.name, c]))
    const pkNames = details.columns.filter((c) => c.key === 'PRI').map((c) => c.name)
    return {
      index: new Map(fields.map((f, i) => [f.name, i])),
      editable: fields.map((f) => {
        const c = byName.get(f.name)
        return !!c && isEditableColumn(c)
      }),
      nullable: fields.map((f) => byName.get(f.name)?.nullable ?? false),
      pk: pkNames.map((n) => ({ name: n, idx: fields.findIndex((f) => f.name === n) }))
    }
  }, [details, fields])

  const rowKey = useCallback(
    (row: CellValue[]): string => JSON.stringify(colInfo!.pk.map((p) => row[p.idx])),
    [colInfo]
  )
  const pkValues = useCallback(
    (row: CellValue[]): Record<string, CellValue> => Object.fromEntries(colInfo!.pk.map((p) => [p.name, row[p.idx]])),
    [colInfo]
  )

  /** Grid rows: new rows first, then loaded rows with pending edits laid over them. */
  const displayRows = useMemo(() => {
    if (!data || !colInfo) return data?.rows ?? []
    const newRows = inserts.map((ins) => data.fields.map((f) => (f.name in ins.values ? ins.values[f.name] : null)))
    const loaded =
      pending.size === 0
        ? data.rows
        : data.rows.map((r) => {
            const p = pending.get(rowKey(r))
            if (!p) return r
            const copy = r.slice()
            for (const [col, v] of Object.entries(p.set)) copy[colInfo.index.get(col)!] = v
            return copy
          })
    return inserts.length ? [...newRows, ...loaded] : loaded
  }, [data, colInfo, inserts, pending, rowKey])

  const touch = (): void => {
    setSavedMsg(null)
    setSaveError(null)
  }

  const editing = useMemo<GridEditing | undefined>(() => {
    if (!data || !colInfo || !editability?.editable || colInfo.pk.some((p) => p.idx < 0)) return undefined
    const nNew = inserts.length
    const loadedRow = (row: number): CellValue[] | undefined => (row >= nNew ? data.rows[row - nNew] : undefined)

    return {
      editable: (col) => colInfo.editable[col],
      nullable: (col) => colInfo.nullable[col],
      rowState: (row) => {
        if (row < nNew) return 'new'
        const r = loadedRow(row)
        return r && deleted.has(rowKey(r)) ? 'deleted' : undefined
      },
      isDefault: (row, col) => row < nNew && !(data.fields[col].name in inserts[row].values),
      isEdited: (row, col) => {
        const r = loadedRow(row)
        return !!r && data.fields[col].name in (pending.get(rowKey(r))?.set ?? {})
      },
      onEdit: (row, col, value) => {
        const name = data.fields[col].name
        if (row < nNew) {
          const ins = inserts[row]
          // Committing the editor on an untouched DEFAULT cell yields '' – no change.
          if (!(name in ins.values) && value === '') return
          touch()
          setInserts((prev) => prev.map((x) => (x.id === ins.id ? { ...x, values: { ...x.values, [name]: value } } : x)))
          return
        }
        const orig = loadedRow(row)
        if (!orig || deleted.has(rowKey(orig))) return
        // Committing the editor on a NULL cell yields '' – treat that as "no change".
        if (displayRows[row][col] === null && value === '') return
        const k = rowKey(orig)
        touch()
        setPending((prev) => {
          const next = new Map(prev)
          const entry: PendingRow = next.get(k) ?? { key: pkValues(orig), set: {} }
          const set = { ...entry.set }
          if (sameValue(orig[col], value)) delete set[name]
          else set[name] = value
          if (Object.keys(set).length === 0) next.delete(k)
          else next.set(k, { ...entry, set })
          return next
        })
      },
      onDeleteRows: (rows) => {
        touch()
        // New rows are simply dropped.
        const dropIds = new Set(rows.filter((r) => r < nNew).map((r) => inserts[r].id))
        if (dropIds.size) setInserts((prev) => prev.filter((x) => !dropIds.has(x.id)))
        // Loaded rows toggle: if every selected one is already marked, unmark; otherwise mark all.
        const loaded = rows.map(loadedRow).filter((r): r is CellValue[] => !!r)
        if (loaded.length === 0) return
        const keys = loaded.map(rowKey)
        const unmark = keys.every((k) => deleted.has(k))
        setDeleted((prev) => {
          const next = new Map(prev)
          loaded.forEach((r, i) => (unmark ? next.delete(keys[i]) : next.set(keys[i], pkValues(r))))
          return next
        })
        // A deleted row's pending edits are moot.
        if (!unmark) {
          setPending((prev) => {
            const next = new Map(prev)
            keys.forEach((k) => next.delete(k))
            return next
          })
        }
      }
    }
  }, [data, colInfo, editability?.editable, inserts, pending, deleted, rowKey, pkValues, displayRows])

  // For the value inspector: real column types, and rows described by primary key.
  const columnTypes = useMemo(() => {
    if (!details || !fields) return undefined
    const byName = new Map(details.columns.map((c) => [c.name, c.type]))
    return fields.map((f) => byName.get(f.name) ?? f.type)
  }, [details, fields])
  const describeRow = useCallback(
    (row: number): string => {
      if (row < inserts.length) return 'new row'
      const r = data?.rows[row - inserts.length]
      if (!r || !colInfo || colInfo.pk.some((p) => p.idx < 0)) return `row ${row + 1}`
      const pk = colInfo.pk.map((p) => `${p.name} = ${r[p.idx]}`).join(', ')
      return deleted.has(rowKey(r)) ? `${pk} (marked for deletion)` : pk
    },
    [inserts.length, data, colInfo, deleted, rowKey]
  )

  const addRow = (): void => {
    touch()
    setInserts((prev) => [{ id: nextRowId++, values: {} }, ...prev])
  }

  const changeSet = (): ChangeSet => ({
    schema,
    table,
    deletes: [...deleted.values()].map((key) => ({ key })),
    updates: [...pending.values()].map(({ key, set }) => ({ key, set })),
    inserts: inserts.map(({ values }) => ({ values }))
  })

  const viewSql = async (): Promise<void> => {
    const r = await window.api.previewChanges(changeSet())
    if (r.ok) setPreview(r.value)
    else setSaveError(r.error)
  }
  const discard = (): void => {
    setPending(new Map())
    setDeleted(new Map())
    setInserts([])
    setSaveError(null)
  }
  const accept = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    const r = await window.api.applyChanges(changeSet())
    setSaving(false)
    if (!r.ok) {
      setSaveError(r.error)
      return
    }
    discard()
    setSavedMsg(`Saved: ${summarize(r.value.inserted, r.value.updated, r.value.deleted)}`)
    void loadData()
  }

  const total = data?.total ?? 0
  const lastOffset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE)

  return (
    <div className="table-view">
      <div className="table-header">
        <span className="table-title">
          <span className="muted">{schema}.</span>
          {table}
        </span>
        <div className="segmented">
          <button className={view === 'data' ? 'active' : ''} onClick={() => onViewChange('data')}>
            Data
          </button>
          <button className={view === 'schema' ? 'active' : ''} onClick={() => onViewChange('schema')}>
            Schema
          </button>
        </div>
        {view === 'data' && editability && editability.editable && (
          <>
            <button onClick={addRow} disabled={!editing} title="Insert a new row (shown at the top)">
              + Add row
            </button>
            <button
              onClick={() => editing?.onDeleteRows(selectedRows)}
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
        <button onClick={refresh} title="Reload (pending edits are kept)">
          ⟳ Refresh
        </button>
      </div>

      {view === 'schema' ? (
        <div className="table-body scroll">
          {detailsError && <pre className="error-panel">{detailsError}</pre>}
          {details ? <TableSchemaView details={details} onOpenSql={onOpenSql} /> : !detailsError && <div className="placeholder">Loading…</div>}
        </div>
      ) : (
        <>
          <FilterBar
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
                selectionResetKey={inserts.length}
                sourceLabel={`${schema}.${table}`}
                columnTypes={columnTypes}
                describeRow={describeRow}
              />
            ) : (
              <div className="placeholder">Loading…</div>
            )}
          </div>
          {(changeCount > 0 || saveError) && (
            <div className={`pending-bar ${saveError ? 'has-error' : ''}`}>
              {changeCount > 0 && <span>✎ Pending: {summarize(inserts.length, pending.size, deleted.size)}</span>}
              {saveError && <span className="pending-error">{saveError}</span>}
              <div className="spacer" />
              {changeCount > 0 && (
                <>
                  <button onClick={viewSql} disabled={saving}>
                    View SQL
                  </button>
                  <button onClick={discard} disabled={saving}>
                    Cancel
                  </button>
                  <button className="primary" onClick={accept} disabled={saving}>
                    {saving ? 'Saving…' : 'Accept'}
                  </button>
                </>
              )}
              {changeCount === 0 && (
                <button className="icon" onClick={() => setSaveError(null)} title="Dismiss">
                  ✕
                </button>
              )}
            </div>
          )}
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
