import { useState } from 'react'
import { EXPORT_COMMANDS } from '../../../shared/menuCommands'
import { useMenuActions } from '../menuActions'
import type { CellValue, ExportFormat, ResultField } from '../../../shared/types'

interface Props {
  fields: ResultField[]
  rows: CellValue[][]
  name: string
  page?: boolean
  disabled?: boolean
}

export function ExportRows({ fields, rows, name, page, disabled }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = page ? 'Export page' : 'Export results'

  async function save(format: ExportFormat): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.exportRows(format, name, fields.map((field) => field.name), rows)
      if (!result.ok) setError(result.error)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useMenuActions(EXPORT_COMMANDS, !busy && !disabled, (command) => {
    void save(command === 'export-csv' ? 'csv' : 'json')
  })

  return (
    <div className="row-export">
      {error && <span className="row-export-error" role="alert" title={error}>{error}</span>}
      <select
        aria-label={label}
        title={page ? 'Export the saved rows on this page' : label}
        value=""
        disabled={busy || disabled}
        onChange={(e) => {
          const format = e.target.value
          if (format === 'csv' || format === 'json') void save(format)
        }}
      >
        <option value="" disabled>{busy ? 'Exporting…' : label}</option>
        <option value="csv">CSV</option>
        <option value="json">JSON</option>
      </select>
    </div>
  )
}
