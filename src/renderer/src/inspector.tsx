import { createContext, useContext, type MutableRefObject } from 'react'
import type { CellValue } from '../../shared/types'

// Shared state for the right-hand value inspector. Any ResultsGrid can feed it:
// the grid the user last selected a cell in becomes the "owner" (tracked in a
// ref, so selecting cells doesn't re-render the app), and while the panel is
// open the owner pushes the selected cell's value – also when that value
// changes underneath (e.g. it was just edited).

export interface InspectedValue {
  value: CellValue
  /** New-row cell that will get the column default. */
  isDefault?: boolean
  column: string
  /** Column type, e.g. "json", "varchar(200)" or a protocol type like "VAR_STRING". */
  type: string
  /** Where it came from, e.g. "shop.customers · row 12". */
  source: string
  /** Set when the cell can be edited: stages a pending change for it. */
  onChange?: (value: CellValue) => void
  nullable?: boolean
  /** The cell has a pending change (or belongs to a new row). */
  edited?: boolean
  /** Drops the cell's pending change (for a new row: back to DEFAULT). */
  onRevert?: () => void
  /** Why the value can't be edited, when it can't. */
  readOnlyReason?: string
  /** Foreign-key cell: opens the referenced row. */
  link?: { label: string; open: () => void }
}

export interface InspectorApi {
  open: boolean
  setOpen: (open: boolean) => void
  /** null empties the panel. */
  show: (v: InspectedValue | null) => void
  /** Id of the grid whose selection the panel follows. */
  ownerRef: MutableRefObject<string | null>
}

export const InspectorContext = createContext<InspectorApi | null>(null)

export function useInspector(): InspectorApi | null {
  return useContext(InspectorContext)
}
