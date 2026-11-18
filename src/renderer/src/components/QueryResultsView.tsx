import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { ExportRows } from './ExportRows'
import { PendingBar, summarize } from './PendingBar'
import { ResultsGrid } from './ResultsGrid'
import { SqlPreviewModal } from './SqlPreviewModal'
import { useRowEditing } from '../useRowEditing'
import type { QueryResultSet, ResultEditInfo } from '../../../shared/types'

interface Props {
  sets: QueryResultSet[]
  /** The SQL that produced the result. */
  sql: string
  label: string
  /** Shown once, e.g. after the query re-ran to show saved edits. */
  notice?: string
  /** Runs `sql` again after edits were saved, keeping `notice` on the new result. */
  onRerun: (notice: string) => void
  /** Reports whether the result has unsaved edits (so closing the tab can ask first). */
  onDirtyChange: (dirty: boolean) => void
  onOpenSql: (sql: string) => void
}

/** A query's result sets, as tabs when there are several. A single result set can be edited. */
export function QueryResultsView({ sets, sql, label, notice, onRerun, onDirtyChange, onOpenSql }: Props): JSX.Element {
  const [selected, setSelected] = useState(0)
  const id = useId()
  const multiple = sets.length > 1
  const set = sets[Math.min(selected, sets.length - 1)]
  const source = multiple ? `${label} - Result ${selected + 1}` : label

  if (!multiple) {
    return <EditableResult set={set} sql={sql} label={label} notice={notice} onRerun={onRerun} onDirtyChange={onDirtyChange} onOpenSql={onOpenSql} />
  }
  return (
    <div className="query-results">
      <div className="query-results-actions">
        <div className="result-set-tabs" role="tablist" aria-label="Result sets">
          {sets.map((_, index) => (
            <button
              key={index}
              id={`${id}-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={selected === index}
              aria-controls={`${id}-panel`}
              tabIndex={selected === index ? 0 : -1}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                let next: number
                switch (event.key) {
                  case 'ArrowRight':
                    next = (index + 1) % sets.length
                    break
                  case 'ArrowLeft':
                    next = (index + sets.length - 1) % sets.length
                    break
                  case 'Home':
                    next = 0
                    break
                  case 'End':
                    next = sets.length - 1
                    break
                  default: return
                }
                event.preventDefault()
                setSelected(next)
                document.getElementById(`${id}-tab-${next}`)?.focus()
              }}
            >
              Result {index + 1}
            </button>
          ))}
        </div>
        <span className={set.truncated ? 'warn' : 'muted'}>
          {set.truncated ? `Showing ${set.rows.length.toLocaleString()} of ${set.rowCount?.toLocaleString()} rows` : `${set.rows.length.toLocaleString()} rows`}
        </span>
        <ExportRows fields={set.fields} rows={set.rows} name={source} />
      </div>
      <div className="table-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected}`}>
        <ResultsGrid key={selected} fields={set.fields} rows={set.rows} sourceLabel={source} />
      </div>
    </div>
  )
}

const NO_TARGETS: ResultEditInfo['tables'] = []

/**
 * A single result set; its columns read straight from tables can be edited when
 * the main process finds each table's primary key in the result.
 */
function EditableResult({ set, sql, label, notice, onRerun, onDirtyChange, onOpenSql }: Omit<Props, 'sets'> & { set: QueryResultSet }): JSX.Element {
  const { fields, rows } = set
  const [info, setInfo] = useState<ResultEditInfo | null>(null)
  const [selectedRows, setSelectedRows] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(notice ?? null)
  const [preview, setPreview] = useState<string[] | null>(null)

  // Only results with table columns are worth asking about (not `SELECT 1`).
  useEffect(() => {
    if (!fields.some((f) => f.source)) return
    let current = true
    void window.api.resultEditInfo(sql, fields).then((r) => {
      if (current && r.ok) setInfo(r.value)
    })
    return () => {
      current = false
    }
  }, [sql, fields])

  const targets = info?.tables ?? NO_TARGETS
  const singleTable = targets.length === 1
  const touch = useCallback((): void => {
    setSavedMsg(null)
    setSaveError(null)
  }, [])
  const edits = useRowEditing({ fields, rows, targets, allowDelete: singleTable, readOnly: info?.readOnly, onStage: touch })
  const { displayRows, editing, changeCount, isDeleted } = edits

  useEffect(() => {
    onDirtyChange(changeCount > 0)
  }, [changeCount, onDirtyChange])

  const readOnlyColumns = useMemo(() => {
    if (!targets.length) return undefined
    const editable = new Set(targets.flatMap((t) => t.columns.map((c) => c.field)))
    return new Set(fields.map((_, i) => i).filter((i) => !editable.has(i)))
  }, [targets, fields])

  // The inspector names rows by the first table's primary key.
  const describeRow = useCallback(
    (row: number): string => {
      const key = targets[0]?.key
      const r = rows[row]
      if (!key || !r) return `row ${row + 1}`
      const text = key.map((k) => `${targets[0].table}.${k.column} = ${r[k.field]}`).join(', ')
      return isDeleted(row) ? `${text} (marked for deletion)` : text
    },
    [targets, rows, isDeleted]
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
    // Show what the database holds now (triggers, defaults, rows no longer matching the WHERE).
    onRerun(`Saved: ${summarize(r.value)}`)
  }

  return (
    <div className="query-results">
      <div className="query-results-actions">
        <h2 className="pane-heading">Results</h2>
        {editing && (
          <>
            <button
              onClick={() => edits.deleteRows(selectedRows)}
              disabled={!singleTable || selectedRows.length === 0}
              title={
                singleTable
                  ? 'Mark selected rows for deletion (select rows by clicking their numbers). Again to unmark.'
                  : 'Deleting rows is available when the result comes from a single table'
              }
            >
              − Delete rows{singleTable && selectedRows.length > 0 ? ` (${selectedRows.length})` : ''}
            </button>
            <span className="muted edit-hint">
              Double-click a cell to edit {targets.map((t) => t.table).join(', ')}
            </span>
          </>
        )}
        {!editing && info?.reason && <span className="muted edit-hint">{info.reason}</span>}
        {savedMsg && <span className="saved-msg">✓ {savedMsg}</span>}
        <div className="spacer" />
        <ExportRows fields={fields} rows={rows} name={label} />
      </div>
      <div className="table-body">
        <ResultsGrid
          fields={fields}
          rows={displayRows}
          editing={editing}
          onSelectedRowsChange={setSelectedRows}
          sourceLabel={label}
          describeRow={describeRow}
          readOnlyColumns={readOnlyColumns}
        />
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
      {preview && (
        <SqlPreviewModal title={`Pending changes – ${label}`} statements={preview} onClose={() => setPreview(null)} onOpenInEditor={onOpenSql} />
      )}
    </div>
  )
}
