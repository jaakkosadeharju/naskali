import { useCallback, useMemo, useState } from 'react'
import type { GridEditing } from './components/ResultsGrid'
import type { CellValue, ChangeSet, ResultField } from '../../shared/types'
import {
  addInsert,
  canEdit,
  clearInsertValue,
  countChanges,
  dropInserts,
  emptyStaged,
  isDeleted,
  isEdited,
  overlay,
  revertEdit,
  setInsertValue,
  stageEdit,
  toChangeSets,
  toggleDelete,
  type EditTarget,
  type Staged
} from './rowEditing'

interface Options {
  fields: ResultField[] | undefined
  /** The loaded rows, without staged changes. */
  rows: CellValue[][] | undefined
  /** Editable tables; none makes the grid read-only. Keep it stable (useMemo). */
  targets: EditTarget[]
  /** New rows for the first target, shown above the loaded rows. */
  allowInsert?: boolean
  /** Deleting rows of the first target. */
  allowDelete?: boolean
  /** Why a cell can't be edited, by field (for the inspector). Keep it stable. */
  readOnly?: Record<number, string>
  /** Called whenever staged changes change (e.g. to clear a "saved" message). */
  onStage?: () => void
}

export interface RowEditing {
  /** New rows first, then the loaded rows with staged edits laid over them. */
  displayRows: CellValue[][]
  /** For ResultsGrid; undefined when nothing is editable. */
  editing: GridEditing | undefined
  counts: { inserted: number; updated: number; deleted: number }
  changeCount: number
  /** Grid rows above the loaded ones. */
  newRowCount: number
  changeSets: () => ChangeSet[]
  discard: () => void
  addRow: () => void
  deleteRows: (rows: number[]) => void
  /** Whether a grid row is marked for deletion. */
  isDeleted: (row: number) => boolean
}

let nextRowId = 1

/** Staged edits of a grid (table tab or query result) and the GridEditing callbacks for it. */
export function useRowEditing({ fields, rows, targets, allowInsert = false, allowDelete = false, readOnly, onStage }: Options): RowEditing {
  const [staged, setStaged] = useState<Staged>(emptyStaged)
  const stage = useCallback(
    (update: (s: Staged) => Staged) => {
      onStage?.()
      setStaged(update)
    },
    [onStage]
  )

  const loaded = useMemo(() => rows ?? [], [rows])
  const nNew = staged.inserts.length
  const insertColumn = useMemo(
    () => new Map((targets[0]?.columns ?? []).map((c) => [c.field, c])),
    [targets]
  )
  const nullable = useMemo(() => {
    const out = new Map<number, boolean>()
    for (const t of targets) for (const c of t.columns) out.set(c.field, c.nullable)
    return out
  }, [targets])

  const displayRows = useMemo(() => {
    const shown = overlay(staged, targets, loaded)
    if (!nNew || !fields) return shown
    const newRows = staged.inserts.map((ins) =>
      fields.map((_, i) => {
        const column = insertColumn.get(i)?.column
        return column !== undefined && column in ins.values ? ins.values[column] : null
      })
    )
    return [...newRows, ...shown]
  }, [staged, targets, loaded, nNew, fields, insertColumn])

  const loadedRow = useCallback((row: number): CellValue[] | undefined => (row >= nNew ? loaded[row - nNew] : undefined), [loaded, nNew])

  const deleteRows = useCallback(
    (gridRows: number[]): void => {
      const newIds = gridRows.filter((r) => r < nNew).map((r) => staged.inserts[r].id)
      const existing = allowDelete ? gridRows.map(loadedRow).filter((r): r is CellValue[] => !!r) : []
      if (newIds.length === 0 && existing.length === 0) return
      stage((s) => toggleDelete(dropInserts(s, newIds), targets, existing))
    },
    [nNew, staged.inserts, allowDelete, loadedRow, stage, targets]
  )

  const editing = useMemo<GridEditing | undefined>(() => {
    if (!fields || targets.length === 0) return undefined
    return {
      editable: (row, col) => {
        if (row < nNew) return insertColumn.has(col)
        const r = loadedRow(row)
        return !!r && canEdit(targets, r, col)
      },
      readOnlyReason: (row, col) => {
        if (row < nNew) return insertColumn.has(col) ? undefined : readOnly?.[col]
        const r = loadedRow(row)
        if (r && !readOnly?.[col] && targets.some((t) => t.columns.some((c) => c.field === col))) {
          return 'no matching row in this table (its key is NULL)'
        }
        return readOnly?.[col]
      },
      nullable: (col) => nullable.get(col) ?? false,
      rowState: (row) => {
        if (row < nNew) return 'new'
        const r = loadedRow(row)
        return r && isDeleted(staged, targets, r) ? 'deleted' : undefined
      },
      isDefault: (row, col) => {
        if (row >= nNew) return false
        const column = insertColumn.get(col)?.column
        return column === undefined || !(column in staged.inserts[row].values)
      },
      isEdited: (row, col) => {
        const r = loadedRow(row)
        return !!r && isEdited(staged, targets, r, col)
      },
      onEdit: (row, col, value, opts) => {
        const explicit = !!opts?.explicit
        if (row < nNew) {
          const ins = staged.inserts[row]
          const column = insertColumn.get(col)?.column
          if (column === undefined) return
          // Committing the editor on an untouched DEFAULT cell yields '' – no change.
          if (!explicit && !(column in ins.values) && value === '') return
          stage((s) => setInsertValue(s, ins.id, column, value))
          return
        }
        const r = loadedRow(row)
        if (!r || isDeleted(staged, targets, r)) return
        // Committing the editor on a NULL cell yields '' – treat that as "no change".
        if (!explicit && displayRows[row][col] === null && value === '') return
        stage((s) => stageEdit(s, targets, r, col, value))
      },
      revertCell: (row, col) => {
        if (row < nNew) {
          const column = insertColumn.get(col)?.column
          const id = staged.inserts[row].id
          if (column !== undefined) stage((s) => clearInsertValue(s, id, column))
          return
        }
        const r = loadedRow(row)
        if (r) stage((s) => revertEdit(s, targets, r, col))
      },
      onDeleteRows: deleteRows
    }
  }, [fields, targets, nNew, insertColumn, loadedRow, readOnly, nullable, staged, displayRows, stage, deleteRows])

  const rowDeleted = useCallback(
    (row: number): boolean => {
      const r = loadedRow(row)
      return !!r && isDeleted(staged, targets, r)
    },
    [loadedRow, staged, targets]
  )

  const counts = countChanges(staged)
  return {
    displayRows,
    editing,
    counts,
    changeCount: counts.inserted + counts.updated + counts.deleted,
    newRowCount: nNew,
    changeSets: () => toChangeSets(staged, targets),
    discard: () => setStaged(emptyStaged),
    addRow: () => {
      if (allowInsert && targets.length) stage((s) => addInsert(s, nextRowId++))
    },
    deleteRows,
    isDeleted: rowDeleted
  }
}
