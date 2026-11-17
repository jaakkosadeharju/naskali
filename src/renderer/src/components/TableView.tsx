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
  const [pending, setPending] = useState<Map<string, PendingRow>>(new Map())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)

  useEffect(() => {
    onDirtyChange(pending.size > 0)
  }, [pending.size, onDirtyChange])

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

  // The rows as displayed: loaded values with pending edits laid over them.
  const displayRows = useMemo(() => {
    if (!data || !colInfo || pending.size === 0) return data?.rows ?? []
    return data.rows.map((r) => {
      const p = pending.get(rowKey(r))
      if (!p) return r
      const copy = r.slice()
      for (const [col, v] of Object.entries(p.set)) copy[colInfo.index.get(col)!] = v
      return copy
    })
  }, [data, colInfo, pending, rowKey])

  const editing = useMemo<GridEditing | undefined>(() => {
    if (!data || !colInfo || !editability?.editable || colInfo.pk.some((p) => p.idx < 0)) return undefined
    return {
      editable: (col) => colInfo.editable[col],
      nullable: (col) => colInfo.nullable[col],
      isEdited: (row, col) => {
        const r = data.rows[row]
        return !!r && data.fields[col].name in (pending.get(rowKey(r))?.set ?? {})
      },
      onEdit: (row, col, value) => {
        const orig = data.rows[row]
        if (!orig) return
        // Committing the editor on a NULL cell yields '' – treat that as "no change".
        if (displayRows[row][col] === null && value === '') return
        const name = data.fields[col].name
        const k = rowKey(orig)
        setSavedMsg(null)
        setSaveError(null)
        setPending((prev) => {
          const next = new Map(prev)
          const entry: PendingRow = next.get(k) ?? {
            key: Object.fromEntries(colInfo.pk.map((p) => [p.name, orig[p.idx]])),
            set: {}
          }
          const set = { ...entry.set }
          if (sameValue(orig[col], value)) delete set[name]
          else set[name] = value
          if (Object.keys(set).length === 0) next.delete(k)
          else next.set(k, { ...entry, set })
          return next
        })
      }
    }
  }, [data, colInfo, editability?.editable, pending, rowKey, displayRows])

  const changeSet = (): ChangeSet => ({
    schema,
    table,
    updates: [...pending.values()].map(({ key, set }) => ({ key, set }))
  })
  const cellCount = [...pending.values()].reduce((n, p) => n + Object.keys(p.set).length, 0)

  const viewSql = async (): Promise<void> => {
    const r = await window.api.previewChanges(changeSet())
    if (r.ok) setPreview(r.value)
    else setSaveError(r.error)
  }
  const discard = (): void => {
    setPending(new Map())
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
    setPending(new Map())
    setSavedMsg(`Saved ${r.value.statements} row${r.value.statements === 1 ? '' : 's'}`)
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
        {view === 'data' && editability && (
          <span className="muted edit-hint">
            {editability.editable
              ? 'Double-click a cell to edit · Delete sets NULL'
              : editability.reason}
          </span>
        )}
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
              <ResultsGrid fields={data.fields} rows={displayRows} editing={editing} />
            ) : (
              <div className="placeholder">Loading…</div>
            )}
          </div>
          {(pending.size > 0 || saveError) && (
            <div className={`pending-bar ${saveError ? 'has-error' : ''}`}>
              {pending.size > 0 && (
                <span>
                  ✎ {pending.size} row{pending.size === 1 ? '' : 's'} changed ({cellCount} cell{cellCount === 1 ? '' : 's'})
                </span>
              )}
              {saveError && <span className="pending-error">{saveError}</span>}
              <div className="spacer" />
              {pending.size > 0 && (
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
              {pending.size === 0 && (
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
