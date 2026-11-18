import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type CellClickedEventArgs,
  type DrawCellCallback,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme
} from '@glideapps/glide-data-grid'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { COPY_COMMANDS } from '../../../shared/menuCommands'
import { useMenuActions } from '../menuActions'
import { exportRows, exportSelectionAsJson } from '../../../shared/exportRows'
import { temporalCellKind } from '../../../shared/editing'
import type { CellAssignment, CellValue, ExportFormat, ResultField } from '../../../shared/types'
import { useInspector } from '../inspector'
import { editorDriver } from '../monacoSetup'


const darkTheme: Partial<Theme> = {
  accentColor: '#80afff',
  accentLight: 'rgba(128, 175, 255, 0.22)',
  textDark: '#dce5f2',
  textMedium: '#a3b2c7',
  textLight: '#899ab2',
  textHeader: '#d1dced',
  bgCell: '#151a23',
  bgCellMedium: '#1b222e',
  bgHeader: '#1b222e',
  bgHeaderHasFocus: '#253144',
  bgHeaderHovered: '#253144',
  borderColor: 'rgba(255, 255, 255, 0.08)',
  horizontalBorderColor: 'rgba(255, 255, 255, 0.05)',
  bgSearchResult: '#613214',
  fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, monospace',
  baseFontStyle: '13px',
  headerFontStyle: '600 13px'
}
const MUTED = '#899ab2'
const nullTheme: Partial<Theme> = { textDark: MUTED }
const editedTheme: Partial<Theme> = { bgCell: '#4a3f12' }
const editedNullTheme: Partial<Theme> = { bgCell: '#4a3f12', textDark: '#a89a6a' }
const newTheme: Partial<Theme> = { bgCell: '#1d3b25' }
const newMutedTheme: Partial<Theme> = { bgCell: '#1d3b25', textDark: '#6f8f76' }
const deletedTheme: Partial<Theme> = { bgCell: '#46201f', textDark: '#a07070' }
const readOnlyHeaderTheme: Partial<Theme> = { textHeader: MUTED }

function display(v: CellValue): string {
  if (v === null) return 'NULL'
  const s = String(v)
  return s.length > 500 ? s.slice(0, 500) + '…' : s
}

/** Estimates a width from the header and a sample of rows. */
function initialWidth(field: ResultField, idx: number, rows: CellValue[][]): number {
  let chars = field.name.length + 2
  for (let r = 0; r < Math.min(rows.length, 200); r++) chars = Math.max(chars, display(rows[r][idx]).length)
  return Math.min(400, Math.max(80, chars * 8 + 20)) // min fits "DEFAULT"
}

/** Optional editing support; without it the grid is read-only. Row/col are grid indices. */
export interface GridEditing {
  /** Whether a cell can be edited (rows of a joined table without a key can't). */
  editable: (row: number, col: number) => boolean
  /** Why a cell can't be edited, for the inspector; defaults to a generic reason. */
  readOnlyReason?: (row: number, col: number) => string | undefined
  nullable: (col: number) => boolean
  hasDefault: (col: number) => boolean
  isEdited: (row: number, col: number) => boolean
  rowState: (row: number) => 'new' | 'deleted' | undefined
  /** New-row cell that hasn't been given a value (the column's DEFAULT applies). */
  isDefault: (row: number, col: number) => boolean
  /**
   * Stages a cell change. `explicit` marks deliberate edits (e.g. from the inspector) so an empty
   * string on a NULL/DEFAULT cell counts as a change rather than "editor committed without typing".
   */
  onEdit: (row: number, col: number, value: CellAssignment, opts?: { explicit?: boolean }) => void
  /** Drops a cell's pending change (new-row cell: back to DEFAULT). */
  revertCell: (row: number, col: number) => void
  /** Delete key with whole rows selected. */
  onDeleteRows: (rows: number[]) => void
}

interface Props {
  fields: ResultField[]
  rows: CellValue[][]
  editing?: GridEditing
  onSelectedRowsChange?: (rows: number[]) => void
  /** Changing this clears the selection (e.g. when rows are inserted above and indices shift). */
  selectionResetKey?: unknown
  /** Shown in the value inspector, e.g. "Query result" or "shop.customers". */
  sourceLabel: string
  /** Better per-column type names than the protocol's (e.g. "varchar(200)", "json"). */
  columnTypes?: string[]
  /** Row description for the inspector, e.g. "id = 5"; defaults to "row N". Keep it stable (useCallback). */
  describeRow?: (row: number) => string
  /** Cells that link somewhere (foreign keys): drawn with a ↗ button that calls `open`. Keep it stable. */
  cellLinks?: CellLinks
  /** Columns drawn with a muted header (not editable while others are). Keep it stable. */
  readOnlyColumns?: ReadonlySet<number>
}

export interface CellLinks {
  has: (row: number, col: number) => boolean
  /** e.g. "customers where id = 2" */
  label: (row: number, col: number) => string
  open: (row: number, col: number) => void
}

const LINK_SIZE = 18 // px, square button at the cell's right edge
const LINK_HIT = LINK_SIZE + 8 // clickable strip width

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

const emptySelection: GridSelection = { rows: CompactSelection.empty(), columns: CompactSelection.empty() }

function copySelection(selection: GridSelection, col: number, row: number, columnCount: number, rowCount: number) {
  // A context click outside the selection targets just the clicked cell.
  const current = selection.current
  const range = current && [current.range, ...current.rangeStack].find((r) =>
    col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height
  )
  if (range) {
    return {
      columns: indexes(range.x, Math.min(columnCount, range.x + range.width)),
      rows: indexes(range.y, Math.min(rowCount, range.y + range.height)),
      singleCell: current.rangeStack.length === 0 && range.width === 1 && range.height === 1
    }
  }
  if (selection.rows.hasIndex(row)) return { columns: indexes(0, columnCount), rows: selection.rows.toArray().filter((r) => r < rowCount), singleCell: false }
  if (selection.columns.hasIndex(col)) return { columns: selection.columns.toArray().filter((c) => c < columnCount), rows: indexes(0, rowCount), singleCell: false }
  return { columns: [col], rows: [row], singleCell: true }
}

function indexes(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i)
}

interface CopyMenu {
  x: number
  y: number
  columns: number[]
  rows: number[]
  singleCell: boolean
}

export function ResultsGrid({ fields, rows, editing, onSelectedRowsChange, selectionResetKey, sourceLabel, columnTypes, describeRow, cellLinks, readOnlyColumns }: Props): JSX.Element {
  const [columns, setColumns] = useState<GridColumn[]>([])
  const [selection, setSelection] = useState<GridSelection>(emptySelection)
  const [menu, setMenu] = useState<CopyMenu | null>(null)
  const [copyError, setCopyError] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const focusBeforeMenu = useRef<HTMLElement | null>(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const cellLinksRef = useRef(cellLinks)
  cellLinksRef.current = cellLinks

  // A new result (new `fields`) resets sizing and selection; edits only change `rows`.
  // Sizing also reruns once links appear (table details can arrive after the data).
  const hasLinks = !!cellLinks
  useEffect(() => {
    const sample = Math.min(rowsRef.current.length, 50)
    const linked = (col: number): boolean => {
      for (let r = 0; r < sample; r++) if (cellLinksRef.current?.has(r, col)) return true
      return false
    }
    // Columns with link buttons get room for the button.
    setColumns(
      fields.map((f, i) => ({ id: String(i), title: f.name, width: initialWidth(f, i, rowsRef.current) + (linked(i) ? LINK_HIT : 0) }))
    )
  }, [fields, hasLinks])

  useEffect(() => {
    setSelection(emptySelection)
    setMenu(null)
  }, [fields])

  const shownColumns = useMemo(
    () => (readOnlyColumns?.size ? columns.map((c, i) => (readOnlyColumns.has(i) ? { ...c, themeOverride: readOnlyHeaderTheme } : c)) : columns),
    [columns, readOnlyColumns]
  )

  useEffect(() => {
    setSelection(emptySelection)
  }, [selectionResetKey])

  useEffect(() => {
    onSelectedRowsChange?.(selection.rows.toArray())
  }, [selection, onSelectedRowsChange])

  // ---- Value inspector -------------------------------------------------------
  const inspector = useInspector()
  const gridId = useId()
  const inspectorRef = useRef(inspector)
  inspectorRef.current = inspector
  // A grid that goes away (e.g. its query re-ran) must not leave its cell, with callbacks into it, in the panel.
  useEffect(
    () => () => {
      const panel = inspectorRef.current
      if (panel?.ownerRef.current !== gridId) return
      panel.ownerRef.current = null
      panel.show(null)
    },
    [gridId]
  )
  const currentCell = selection.current?.cell
  const [curCol, curRow] = currentCell ?? [-1, -1]

  // While the inspector is open and follows this grid, push the selected cell's
  // value – also when it changes (edits, reloads).
  useEffect(() => {
    if (!inspector?.open || inspector.ownerRef.current !== gridId || curRow < 0 || curRow >= rows.length || !fields[curCol]) return
    const state = editing?.rowState(curRow)
    const isDefault = state === 'new' && !!editing?.isDefault(curRow, curCol)
    const canEdit = !!editing && editing.editable(curRow, curCol) && state !== 'deleted'
    const edited = state === 'new' ? !isDefault : !!editing?.isEdited(curRow, curCol)
    const [row, col] = [curRow, curCol]
    inspector.show({
      value: rows[row][col],
      isDefault,
      column: fields[col].name,
      type: columnTypes?.[col] ?? fields[col].type,
      source: `${sourceLabel} · ${describeRow ? describeRow(row) : `row ${row + 1}`}`,
      onChange: canEdit ? (v) => editing.onEdit(row, col, v, { explicit: true }) : undefined,
      nullable: !!editing?.nullable(col),
      edited,
      onRevert: canEdit && edited ? () => editing.revertCell(row, col) : undefined,
      readOnlyReason: canEdit
        ? undefined
        : !editing
          ? 'read-only result'
          : state === 'deleted'
            ? 'row is marked for deletion'
            : (editing.readOnlyReason?.(row, col) ?? 'column is not editable'),
      link: cellLinks?.has(row, col) ? { label: cellLinks.label(row, col), open: () => cellLinks.open(row, col) } : undefined
    })
  }, [inspector, gridId, curRow, curCol, rows, fields, columnTypes, sourceLabel, describeRow, editing, cellLinks])

  /** Paints a small ↗ button over the right edge of linked (foreign key) cells. */
  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent()
      if (!cellLinks?.has(args.row, args.col)) return
      const { ctx, rect } = args
      const x = rect.x + rect.width - LINK_SIZE - 4
      const y = rect.y + (rect.height - LINK_SIZE) / 2
      ctx.save()
      roundRect(ctx, x, y, LINK_SIZE, LINK_SIZE, 4)
      ctx.fillStyle = '#2b3a4f'
      ctx.fill()
      ctx.strokeStyle = '#3d5a80'
      ctx.lineWidth = 1
      ctx.stroke()
      // Arrow ↗ drawn with lines (font glyphs vary by system).
      ctx.strokeStyle = '#9cdcfe'
      ctx.lineWidth = 1.6
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x + 5.5, y + LINK_SIZE - 5.5)
      ctx.lineTo(x + LINK_SIZE - 5.5, y + 5.5)
      ctx.moveTo(x + 8, y + 5.5)
      ctx.lineTo(x + LINK_SIZE - 5.5, y + 5.5)
      ctx.lineTo(x + LINK_SIZE - 5.5, y + 10.5)
      ctx.stroke()
      ctx.restore()
    },
    [cellLinks]
  )

  /** A click on a link button opens the link instead of selecting the cell. */
  const onCellClicked = useCallback(
    ([col, row]: Item, e: CellClickedEventArgs) => {
      if (!cellLinks?.has(row, col) || e.localEventX < e.bounds.width - LINK_HIT) return
      e.preventDefault()
      cellLinks.open(row, col)
    },
    [cellLinks]
  )

  const onGridSelectionChange = useCallback(
    (sel: GridSelection) => {
      setSelection(sel)
      if (sel.current && inspector) inspector.ownerRef.current = gridId
    },
    [inspector, gridId]
  )

  /** Enter / double-click on a cell that can't be edited opens it in the inspector. */
  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      const editable = editing?.editable(row, col) && editing.rowState(row) !== 'deleted'
      if (editable || !inspector) return
      inspector.ownerRef.current = gridId
      inspector.setOpen(true)
    },
    [editing, inspector, gridId]
  )

  const numeric = useMemo(() => fields.map((f) => f.numeric), [fields])

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = rows[row]?.[col] ?? null
      // Linked cells keep their value on the left; the ↗ button sits on the right.
      const align = numeric[col] && !cellLinks?.has(row, col) ? 'right' : 'left'
      const state = editing?.rowState(row)
      if (state === 'new' && editing?.isDefault(row, col)) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: 'DEFAULT',
          allowOverlay: editing.editable(row, col),
          readonly: !editing.editable(row, col),
          contentAlign: 'left', // right-aligned it gets clipped in narrow numeric columns
          themeOverride: newMutedTheme
        }
      }
      let theme: Partial<Theme> | undefined
      if (state === 'deleted') theme = deletedTheme
      else if (state === 'new') theme = v === null ? newMutedTheme : newTheme
      else if (editing?.isEdited(row, col)) theme = v === null ? editedNullTheme : editedTheme
      else if (v === null) theme = nullTheme
      const readonly = !editing?.editable(row, col) || state === 'deleted'
      return {
        kind: GridCellKind.Text,
        data: v === null ? '' : String(v),
        displayData: display(v),
        allowOverlay: !readonly,
        readonly,
        contentAlign: align,
        themeOverride: theme
      }
    },
    [rows, numeric, editing, cellLinks]
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, value: EditableGridCell) => {
      if (value.kind === GridCellKind.Text) editing?.onEdit(row, col, value.data)
    },
    [editing]
  )

  /** Delete key: selected whole rows → delete rows; a cell range → set nullable cells to NULL. */
  const onDelete = useCallback(
    (sel: GridSelection): boolean => {
      if (!editing) return false
      if (sel.rows.length > 0) {
        editing.onDeleteRows(sel.rows.toArray())
        setSelection(emptySelection)
        return false
      }
      const r = sel.current?.range
      if (!r) return false
      for (let row = r.y; row < r.y + r.height; row++) {
        if (editing.rowState(row) === 'deleted') continue
        for (let col = r.x; col < r.x + r.width; col++) {
          if (editing.editable(row, col) && editing.nullable(col)) editing.onEdit(row, col, null)
        }
      }
      return false // handled; skip Glide's default "clear to empty"
    },
    [editing]
  )

  function openCopyMenu([col, row]: Item, x: number, y: number): void {
    focusBeforeMenu.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCopyError(false)
    setMenu({ x, y, ...copySelection(selection, col, row, fields.length, rows.length) })
  }

  function closeCopyMenu(): void {
    setMenu(null)
    focusBeforeMenu.current?.focus()
  }

  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(null)
    }
    window.addEventListener('pointerdown', dismiss, true)
    return () => window.removeEventListener('pointerdown', dismiss, true)
  }, [menu])

  async function copyAs(format: ExportFormat | 'json-with-headers', target: Pick<CopyMenu, 'columns' | 'rows'>): Promise<void> {
    try {
      const headers = target.columns.map((col) => fields[col].name)
      const values = target.rows.map((row) => target.columns.map((col) => rows[row]?.[col] ?? null))
      const text = format === 'json-with-headers'
        ? exportSelectionAsJson(headers, values)
        : Array.from(exportRows(format, headers, values)).join('')
      await navigator.clipboard.writeText(text)
      if (menu) closeCopyMenu()
      setCopyError(false)
    } catch {
      setCopyError(true)
    }
  }

  const cell = selection.current?.cell
  const selectedRow = cell?.[1] ?? selection.rows.first()
  const selectedColumn = cell?.[0] ?? selection.columns.first()
  const hasCopySelection = fields.length > 0 && rows.length > 0 &&
    (selectedRow !== undefined || selectedColumn !== undefined)
  useMenuActions(COPY_COMMANDS, hasCopySelection, (command) => {
    const target = copySelection(selection, selectedColumn ?? 0, selectedRow ?? 0, fields.length, rows.length)
    const format = command === 'copy-csv' ? 'csv' : command === 'copy-json' ? 'json' : 'json-with-headers'
    void copyAs(format, target)
  })

  const quickValues: { label: string; apply: () => void }[] = []
  if (menu?.singleCell && editing) {
    const [col] = menu.columns
    const [row] = menu.rows
    const state = editing.rowState(row)
    if (editing.editable(row, col) && state !== 'deleted') {
      const driver = editorDriver()
      const type = columnTypes?.[col] ?? fields[col].type
      const set = (label: string, value: CellAssignment): void => {
        quickValues.push({ label, apply: () => editing.onEdit(row, col, value, { explicit: true }) })
      }
      if (editing.nullable(col)) set('Set to NULL', null)
      if (state === 'new') {
        quickValues.push({ label: 'Set to default', apply: () => editing.revertCell(row, col) })
      } else if (driver !== 'sqlite' && (editing.hasDefault(col) || editing.nullable(col))) {
        set('Set to default', { kind: 'default' })
      }
      const temporal = temporalCellKind(type, driver === 'mssql')
      if (temporal) set(temporal === 'date' ? 'Set to today' : 'Set to now', { kind: 'current' })
      if (/^bool(?:ean)?$/i.test(type) || (driver === 'mssql' && /^bit$/i.test(type))) {
        set('Set to true', true)
        set('Set to false', false)
      }
    }
  }

  return (
    <>
      <DataEditor
        columns={shownColumns}
        rows={rows.length}
        getCellContent={getCellContent}
        getCellsForSelection={true}
        onCellEdited={editing ? onCellEdited : undefined}
        onDelete={editing ? onDelete : undefined}
        gridSelection={selection}
        onGridSelectionChange={onGridSelectionChange}
        onCellActivated={onCellActivated}
        onCellContextMenu={(cell, event) => {
          if (cell[0] < 0 || cell[1] < 0 || cell[1] >= rows.length) return
          event.preventDefault()
          openCopyMenu(cell, event.bounds.x + event.localEventX, event.bounds.y + event.localEventY)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          const cell = selection.current?.cell ?? event.location
          if (!event.bounds || !cell || cell[0] < 0 || cell[1] < 0 || cell[1] >= rows.length) return
          event.cancel()
          openCopyMenu(cell, event.bounds.x, event.bounds.y + event.bounds.height)
        }}
        onCellClicked={cellLinks ? onCellClicked : undefined}
        drawCell={cellLinks ? drawCell : undefined}
        theme={darkTheme}
        rowMarkers="clickable-number"
        rowSelect="multi"
        smoothScrollX
        smoothScrollY
        width="100%"
        height="100%"
        onColumnResize={(_col, newSize, colIndex) =>
          setColumns((cs) => cs.map((c, i) => (i === colIndex ? { ...c, width: newSize } : c)))
        }
      />
      {copyError && !menu && <div className="grid-copy-error" role="alert">Clipboard unavailable</div>}
      {menu && createPortal(
        <div
          ref={menuRef}
          className="grid-copy-menu"
          role="group"
          aria-label={quickValues.length ? 'Cell actions' : 'Copy cells'}
          style={{
            left: `clamp(4px, ${menu.x}px, calc(100vw - 196px))`,
            top: `clamp(4px, ${menu.y}px, calc(100vh - ${120 + quickValues.length * 28}px))`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              closeCopyMenu()
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setMenu(null)
          }}
        >
          {quickValues.map(({ label, apply }) => (
            <button key={label} type="button" onClick={() => {
              apply()
              closeCopyMenu()
            }}>{label}</button>
          ))}
          {quickValues.length > 0 && <hr />}
          <button type="button" onClick={() => void copyAs('csv', menu)}>Copy as CSV</button>
          <button type="button" onClick={() => void copyAs('json', menu)}>Copy as JSON</button>
          <button type="button" onClick={() => void copyAs('json-with-headers', menu)}>Copy as JSON with headers</button>
          {copyError && <span role="alert">Clipboard unavailable</span>}
        </div>,
        document.body
      )}
    </>
  )
}
