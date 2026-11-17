import {
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme
} from '@glideapps/glide-data-grid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, ResultField } from '../../../shared/types'

const NUMERIC = new Set(['TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR'])

const darkTheme: Partial<Theme> = {
  accentColor: '#3794ff',
  accentLight: 'rgba(55, 148, 255, 0.2)',
  textDark: '#d4d4d4',
  textMedium: '#a0a0a0',
  textLight: '#7a7a7a',
  textHeader: '#cccccc',
  bgCell: '#1e1e1e',
  bgCellMedium: '#252526',
  bgHeader: '#252526',
  bgHeaderHasFocus: '#2d2d30',
  bgHeaderHovered: '#2d2d30',
  borderColor: 'rgba(255, 255, 255, 0.08)',
  horizontalBorderColor: 'rgba(255, 255, 255, 0.05)',
  bgSearchResult: '#613214',
  fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, monospace',
  baseFontStyle: '13px',
  headerFontStyle: '600 13px'
}
const nullTheme: Partial<Theme> = { textDark: '#6a6a6a' }
const editedTheme: Partial<Theme> = { bgCell: '#4a3f12' }
const editedNullTheme: Partial<Theme> = { bgCell: '#4a3f12', textDark: '#a89a6a' }

function display(v: CellValue): string {
  if (v === null) return 'NULL'
  const s = String(v)
  return s.length > 500 ? s.slice(0, 500) + '…' : s
}

/** Estimates a width from the header and a sample of rows. */
function initialWidth(field: ResultField, idx: number, rows: CellValue[][]): number {
  let chars = field.name.length + 2
  for (let r = 0; r < Math.min(rows.length, 200); r++) chars = Math.max(chars, display(rows[r][idx]).length)
  return Math.min(400, Math.max(60, chars * 8 + 20))
}

/** Optional editing support; without it the grid is read-only. */
export interface GridEditing {
  editable: (col: number) => boolean
  nullable: (col: number) => boolean
  isEdited: (row: number, col: number) => boolean
  onEdit: (row: number, col: number, value: CellValue) => void
}

interface Props {
  fields: ResultField[]
  rows: CellValue[][]
  editing?: GridEditing
}

export function ResultsGrid({ fields, rows, editing }: Props): JSX.Element {
  const [columns, setColumns] = useState<GridColumn[]>([])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // Size columns when a new result arrives, not on every edit (rows change then too).
  useEffect(() => {
    setColumns(fields.map((f, i) => ({ id: String(i), title: f.name, width: initialWidth(f, i, rowsRef.current) })))
  }, [fields])

  const numeric = useMemo(() => fields.map((f) => NUMERIC.has(f.type)), [fields])

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = rows[row]?.[col] ?? null
      const edited = editing?.isEdited(row, col) ?? false
      return {
        kind: GridCellKind.Text,
        data: v === null ? '' : String(v),
        displayData: display(v),
        allowOverlay: true,
        readonly: !editing?.editable(col),
        contentAlign: numeric[col] ? 'right' : 'left',
        themeOverride: edited ? (v === null ? editedNullTheme : editedTheme) : v === null ? nullTheme : undefined
      }
    },
    [rows, numeric, editing]
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, value: EditableGridCell) => {
      if (value.kind === GridCellKind.Text) editing?.onEdit(row, col, value.data)
    },
    [editing]
  )

  /** Delete/Backspace on a selection sets nullable editable cells to NULL. */
  const onDelete = useCallback(
    (sel: GridSelection): boolean => {
      const r = sel.current?.range
      if (!editing || !r) return false
      for (let row = r.y; row < r.y + r.height; row++) {
        for (let col = r.x; col < r.x + r.width; col++) {
          if (editing.editable(col) && editing.nullable(col)) editing.onEdit(row, col, null)
        }
      }
      return false // we handled it; skip Glide's default "clear to empty"
    },
    [editing]
  )

  return (
    <DataEditor
      columns={columns}
      rows={rows.length}
      getCellContent={getCellContent}
      getCellsForSelection={true}
      onCellEdited={editing ? onCellEdited : undefined}
      onDelete={editing ? onDelete : undefined}
      theme={darkTheme}
      rowMarkers="number"
      smoothScrollX
      smoothScrollY
      width="100%"
      height="100%"
      onColumnResize={(_col, newSize, colIndex) =>
        setColumns((cs) => cs.map((c, i) => (i === colIndex ? { ...c, width: newSize } : c)))
      }
    />
  )
}
