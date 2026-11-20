import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ColumnInfo, CreateTableAction, DriverKind, NewTableColumn, SchemaInfo, TableAction } from '../../../shared/types'

export type DesignerRequest =
  | { kind: 'create'; schema: string }
  | { kind: 'edit'; schema: string; table: string }
  | { kind: 'drop' | 'truncate'; schema: string; table: string }

export function TableDesigner({ request, schemas, driver, onClose, onApply, onOpenSql }: {
  request: DesignerRequest
  schemas: SchemaInfo[]
  driver: DriverKind
  onClose: () => void
  onApply: (action: TableAction) => Promise<string | null>
  onOpenSql: (sql: string) => void
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  const apply = async (action: TableAction): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const message = await onApply(action)
      if (message) setError(message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const destructive = request.kind === 'drop' || request.kind === 'truncate'
  const title = request.kind === 'create' ? 'New table' : request.kind === 'edit'
    ? 'Edit table schema' : request.kind === 'drop' ? 'Drop table' : 'Truncate table'
  let content: ReactNode
  if (request.kind === 'create') {
    content = <CreateTable schemas={schemas} driver={driver} initialSchema={request.schema} onOpenSql={onOpenSql} onApply={apply} onClose={onClose} />
  } else if (request.kind === 'edit') {
    const columns = schemas.find((s) => s.name === request.schema)?.tables.find((t) => t.name === request.table)?.columns ?? []
    content = <EditColumns driver={driver} schema={request.schema} table={request.table} columns={columns} onApply={apply} onClose={onClose} />
  } else {
    content = (
      <>
        <p>
          {request.kind === 'drop' ? 'Permanently remove' : 'Permanently delete all rows from'}{' '}
          <strong>{request.schema}.{request.table}</strong>
          {request.kind === 'drop' ? ' and delete all of its data?' : '? The table and its schema will be kept.'}
        </p>
        {request.kind === 'truncate' && driver === 'sqlite' && <p className="muted">SQLite uses DELETE, which runs delete triggers and foreign-key actions.</p>}
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={onClose}>Cancel</button>
          <button type="button" className="danger" onClick={() => void apply(request)}>
            {title}
          </button>
        </div>
      </>
    )
  }

  return (
    <dialog
      ref={dialog}
      className={`dialog table-designer${destructive ? ' table-confirm' : ''}`}
      aria-labelledby="table-designer-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!submitting.current) onClose()
      }}
    >
      <h2 id="table-designer-title">{title}</h2>
      <fieldset disabled={busy}>{content}</fieldset>
      {busy && <p role="status" className="muted">Applying change…</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </dialog>
  )
}

type FormActions = {
  onApply: (action: TableAction) => Promise<void>
  onClose: () => void
}

const COLUMN_TYPES: Record<DriverKind, readonly string[]> = {
  mysql: ['INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'DECIMAL(10,2)', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON', 'BLOB'],
  postgres: ['INTEGER', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'NUMERIC(10,2)', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'UUID', 'JSONB', 'BYTEA'],
  mssql: ['INT', 'BIGINT', 'NVARCHAR(255)', 'NVARCHAR(MAX)', 'DECIMAL(10,2)', 'BIT', 'DATE', 'DATETIME2', 'DATETIMEOFFSET', 'UNIQUEIDENTIFIER', 'VARBINARY(MAX)'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'DATETIME']
}

const AUTO_INCREMENT = 'auto-increment'
const DEFAULT_HINT = "Default uses SQL literal syntax, for example 0, 'pending', or CURRENT_TIMESTAMP."

function ColumnTypeInput({ driver, label, value, onChange, required = true, autoIncrement, allowAutoIncrement }: {
  driver: DriverKind
  label: string
  value: string
  onChange: (value: string, autoIncrement?: boolean) => void
  required?: boolean
  autoIncrement?: boolean
  allowAutoIncrement?: boolean
}): JSX.Element {
  const options = COLUMN_TYPES[driver]
  const [custom, setCustom] = useState(() => Boolean(!autoIncrement && value && !options.includes(value)))

  return (
    <div className="designer-type">
      <select aria-label={label} required={required} value={autoIncrement ? AUTO_INCREMENT : custom ? 'custom' : value} onChange={(event) => {
        const choice = event.target.value
        setCustom(choice === 'custom')
        onChange(choice === 'custom' || choice === AUTO_INCREMENT ? '' : choice, choice === AUTO_INCREMENT)
      }}>
        <option value="" disabled>Select type</option>
        {allowAutoIncrement !== undefined && (
          <option value={AUTO_INCREMENT} disabled={!allowAutoIncrement}>Integer (auto-increment primary key)</option>
        )}
        {options.map((type) => (
          <option key={type} value={type}>
            {(driver === 'mssql' && type === 'DATETIME2') || (driver === 'sqlite' && type === 'DATETIME')
              ? `Timestamp (${type})` : type}
          </option>
        ))}
        <option value="custom">Custom type…</option>
      </select>
      {custom && (
        <input required autoFocus aria-label={`Custom ${label.toLowerCase()}`} placeholder="e.g. VARCHAR(100)" value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  )
}

const emptyColumn: NewTableColumn = { name: '', type: '', nullable: true, primaryKey: false }

const hasColumnDetails = (column: NewTableColumn): boolean =>
  Boolean(column.name.trim() || column.type.trim() || column.primaryKey || column.autoIncrement
    || !column.nullable || column.defaultValue?.trim())

type DraftColumn = NewTableColumn & { id: number }
type ForeignKeyDraft = {
  id: number
  target: string
  pairs: { id: number; local: string; referenced: string }[]
}

function CreateTable({ schemas, driver, initialSchema, onApply, onClose, onOpenSql }: FormActions & {
  schemas: SchemaInfo[]
  driver: DriverKind
  initialSchema: string
  onOpenSql: (sql: string) => void
}): JSX.Element {
  const [schema, setSchema] = useState(initialSchema)
  const [table, setTable] = useState('')
  const [columns, setColumns] = useState<DraftColumn[]>([{ id: 0, ...emptyColumn }])
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyDraft[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const nextId = useRef(1)

  const pendingFocus = useRef<number | null>(null)
  const newColumnName = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    if (pendingFocus.current !== null && newColumnName.current) {
      newColumnName.current.focus()
      pendingFocus.current = null
    }
  }, [columns])

  const addColumn = (): void => {
    const id = nextId.current++
    pendingFocus.current = id
    setColumns((rows) => [...rows, { id, ...emptyColumn }])
  }

  const update = (id: number, change: Partial<NewTableColumn>): void =>
    setColumns((rows) => rows.map((row) => row.id === id ? { ...row, ...change } : row))

  const targets = schemas
    .filter((item) => driver !== 'sqlite' || item.name === schema)
    .flatMap((item) => item.tables.filter((t) => t.type === 'BASE TABLE').map((t) => ({
      key: JSON.stringify([item.name, t.name]), schema: item.name, table: t.name, columns: t.columns
    })))
  const newPair = (): ForeignKeyDraft['pairs'][number] => ({ id: nextId.current++, local: '', referenced: '' })

  const submit = async (showSql: boolean): Promise<void> => {
    setPreviewError(null)
    const action: CreateTableAction = {
      kind: 'create',
      schema,
      table: table.trim(),
      columns: columns.filter(hasColumnDetails).map(({ id: _id, ...column }) => ({ ...column, name: column.name.trim() })),
      foreignKeys: []
    }
    for (const fk of foreignKeys) {
      const target = targets.find((item) => item.key === fk.target)
      const local = fk.pairs.map((pair) => columns.find((column) => String(column.id) === pair.local)?.name.trim() ?? '')
      const referenced = fk.pairs.map((pair) => pair.referenced)
      if (!target || local.some((name) => !name) || referenced.some((name) => !target.columns.some((c) => c.name === name))) {
        setPreviewError('Choose a referenced table and complete each foreign-key column pair.')
        return
      }
      action.foreignKeys.push({ columns: local, refSchema: target.schema, refTable: target.table, refColumns: referenced })
    }
    if (!showSql) {
      await onApply(action)
      return
    }
    setPreviewing(true)
    try {
      const result = await window.api.previewCreateTable(action)
      if (result.ok) {
        setCopied(false)
        setPreview(result.value)
      } else setPreviewError(result.error)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewing(false)
    }
  }

  if (preview !== null) {
    return (
      <div className="designer-preview">
        <label>CREATE TABLE SQL<textarea className="mono" value={preview} readOnly rows={Math.min(preview.split('\n').length, 16)} /></label>
        {previewError && <p role="alert" className="error">{previewError}</p>}
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={() => { setPreview(null); setPreviewError(null) }}>Back to design</button>
          <div className="spacer" />
          <button type="button" onClick={() => void navigator.clipboard.writeText(preview)
            .then(() => setCopied(true))
            .catch(() => setPreviewError('Could not copy SQL to the clipboard.'))}>{copied ? 'Copied ✓' : 'Copy SQL'}</button>
          <button type="button" className="primary" onClick={() => {
            onOpenSql(preview)
            onClose()
          }}>Open in editor</button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      if (previewing) return
      const submitter = (event.nativeEvent as SubmitEvent).submitter
      void submit(!(submitter instanceof HTMLButtonElement) || submitter.value !== 'create')
    }}>
      <div className="row">
        <label>Schema<select value={schema} onChange={(event) => setSchema(event.target.value)}>
          {schemas.map((item) => <option key={item.name}>{item.name}</option>)}
        </select></label>
        <label className="grow">Table name<input required autoFocus value={table} onChange={(event) => setTable(event.target.value)} /></label>
      </div>
      <table className="info-table designer-columns">
        <thead><tr><th>Column name</th><th>Type</th><th>Nullable</th><th>Primary key</th><th title={DEFAULT_HINT}>Default</th><th /></tr></thead>
        <tbody>
          {columns.map((column, index) => {
            const required = index === 0 || hasColumnDetails(column)
            const otherIdentity = columns.some((row) => row.id !== column.id && row.autoIncrement)
            const otherPrimaryKey = columns.some((row) => row.id !== column.id && row.primaryKey)
            return (
              <tr key={column.id} onKeyDown={(event) => {
                if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
                  || index !== columns.length - 1 || !column.name.trim() || (!column.autoIncrement && !column.type.trim())) return
                const controls = event.currentTarget.querySelectorAll('input:enabled, select:enabled, button:enabled')
                if (event.target !== controls[controls.length - 1]) return
                event.preventDefault()
                addColumn()
              }}>
                <td><input ref={pendingFocus.current === column.id ? newColumnName : undefined} required={required}
                  aria-label={`Column ${index + 1} name`} value={column.name} onChange={(event) => update(column.id, { name: event.target.value })} /></td>
                <td><ColumnTypeInput driver={driver} label={`Column ${index + 1} type`} value={column.type} required={required}
                  autoIncrement={column.autoIncrement} allowAutoIncrement={!otherPrimaryKey}
                  onChange={(type, autoIncrement) => update(column.id, autoIncrement
                    ? { type, autoIncrement: true, primaryKey: true, nullable: false, defaultValue: '' }
                    : { type, autoIncrement: false })} /></td>
                <td><input type="checkbox" aria-label={`Column ${index + 1} nullable`} disabled={column.primaryKey} checked={!column.primaryKey && column.nullable} onChange={(event) => update(column.id, { nullable: event.target.checked })} /></td>
                <td><input type="checkbox" aria-label={`Column ${index + 1} primary key`} disabled={column.autoIncrement || otherIdentity} checked={column.primaryKey} onChange={(event) => update(column.id, { primaryKey: event.target.checked })} /></td>
                <td><input aria-label={`Column ${index + 1} default value`} title={DEFAULT_HINT} placeholder="None"
                  disabled={column.autoIncrement} value={column.defaultValue ?? ''} onChange={(event) => update(column.id, { defaultValue: event.target.value })} /></td>
                <td><button type="button" aria-label={`Remove column ${index + 1}`} disabled={columns.length === 1} onClick={() => setColumns((rows) => rows.filter((row) => row.id !== column.id))}>×</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div>
        <button type="button" onClick={addColumn}>Add column</button>
      </div>
      <section className="designer-foreign-keys" aria-label="Foreign keys">
        <h3>Foreign keys</h3>
        {foreignKeys.map((fk, index) => {
          const target = targets.find((item) => item.key === fk.target)
          const updateKey = (change: Partial<ForeignKeyDraft>): void =>
            setForeignKeys((keys) => keys.map((key) => key.id === fk.id ? { ...key, ...change } : key))
          const updatePair = (id: number, change: Partial<ForeignKeyDraft['pairs'][number]>): void =>
            updateKey({ pairs: fk.pairs.map((pair) => pair.id === id ? { ...pair, ...change } : pair) })
          return (
            <div className="designer-foreign-key" key={fk.id} role="group" aria-label={`Foreign key ${index + 1}`}>
              <label>Referenced table<select required value={target?.key ?? ''} onChange={(event) => updateKey({
                target: event.target.value, pairs: fk.pairs.map((pair) => ({ ...pair, referenced: '' }))
              })}>
                <option value="" disabled>Select table</option>
                {targets.map((item) => <option value={item.key} key={item.key}>{item.schema}.{item.table}</option>)}
              </select></label>
              {fk.pairs.map((pair, pairIndex) => (
                <div className="row designer-key-pair" key={pair.id}>
                  <label className="grow">Local column<select required value={columns.some((c) => String(c.id) === pair.local && c.name.trim()) ? pair.local : ''} onChange={(event) => updatePair(pair.id, { local: event.target.value })}>
                    <option value="" disabled>Select column</option>
                    {columns.filter((c) => c.name.trim()).map((c) => <option value={c.id} key={c.id}>{c.name.trim()}</option>)}
                  </select></label>
                  <label className="grow">Referenced column<select required disabled={!target} value={target ? pair.referenced : ''} onChange={(event) => updatePair(pair.id, { referenced: event.target.value })}>
                    <option value="" disabled>Select column</option>
                    {target?.columns.map((c) => <option key={c.name}>{c.name}</option>)}
                  </select></label>
                  <button type="button" aria-label={`Remove column pair ${pairIndex + 1}`} disabled={fk.pairs.length === 1} onClick={() => updateKey({
                    pairs: fk.pairs.filter(({ id }) => id !== pair.id)
                  })}>×</button>
                </div>
              ))}
              <div className="dialog-actions">
                <button type="button" onClick={() => updateKey({ pairs: [...fk.pairs, newPair()] })}>Add column pair</button>
                <div className="spacer" />
                <button type="button" onClick={() => setForeignKeys((keys) => keys.filter(({ id }) => id !== fk.id))}>Remove foreign key</button>
              </div>
            </div>
          )
        })}
        <button type="button" disabled={targets.length === 0} onClick={() => {
          const key = { id: nextId.current++, target: '', pairs: [newPair()] }
          setForeignKeys((keys) => [...keys, key])
        }}>Add foreign key</button>
      </section>
      {previewError && <p role="alert" className="error">{previewError}</p>}
      <div className="dialog-actions">
        <div className="spacer" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button disabled={previewing}>{previewing ? 'Generating…' : 'Preview SQL'}</button>
        <button value="create" className="primary" disabled={previewing}>Create table</button>
      </div>
    </form>
  )
}

const COLUMN_OPERATIONS = { addColumn: 'Add column', renameColumn: 'Rename column', dropColumn: 'Drop column' } as const

function EditColumns({ driver, schema, table, columns, onApply, onClose }: FormActions & {
  schema: string
  table: string
  driver: DriverKind
  columns: ColumnInfo[]
}): JSX.Element {
  const [kind, setKind] = useState<keyof typeof COLUMN_OPERATIONS>('addColumn')
  const [column, setColumn] = useState(columns[0]?.name ?? '')
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [nullable, setNullable] = useState(true)
  const [defaultValue, setDefaultValue] = useState('')

  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      if (kind === 'addColumn') void onApply({ kind, schema, table, column: { name: name.trim(), type, nullable, defaultValue } })
      else if (kind === 'renameColumn') void onApply({ kind, schema, table, column, name: name.trim() })
      else void onApply({ kind, schema, table, column })
    }}>
      <p className="mono">{schema}.{table}</p>
      <table className="info-table">
        <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Key</th></tr></thead>
        <tbody>{columns.map((c) => (
          <tr key={c.name}><td className="mono">{c.name}</td><td className="mono">{c.type}</td><td>{c.nullable ? 'Yes' : 'No'}</td><td>{c.key}</td></tr>
        ))}</tbody>
      </table>
      <label>Change<select value={kind} onChange={(event) => {
        setKind(event.target.value as keyof typeof COLUMN_OPERATIONS)
        setName('')
        setType('')
        setDefaultValue('')
      }}>
        <option value="addColumn">Add column</option>
        <option value="renameColumn" disabled={!columns.length}>Rename column</option>
        <option value="dropColumn" disabled={!columns.length}>Drop column</option>
      </select></label>
      {kind !== 'addColumn' && <label>Column<select required value={column} onChange={(event) => setColumn(event.target.value)}>
        {columns.map((c) => <option key={c.name}>{c.name}</option>)}
      </select></label>}
      {kind !== 'dropColumn' && <div className="row">
        <label className="grow">{kind === 'addColumn' ? 'Column name' : 'New name'}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
        {kind === 'addColumn' && <div className="grow designer-type-field"><span>Type</span><ColumnTypeInput driver={driver} label="Type" value={type} onChange={setType} /></div>}
      </div>}
      {kind === 'addColumn' && <label>Default value<input title={DEFAULT_HINT} placeholder="None" value={defaultValue}
        onChange={(event) => setDefaultValue(event.target.value)} /></label>}
      {kind === 'addColumn' && <label className="check"><input type="checkbox" checked={nullable} onChange={(event) => setNullable(event.target.checked)} />Allow NULL</label>}
      {kind === 'dropColumn' && <p className="error">Dropping {column} permanently deletes the column and its data.</p>}
      <div className="dialog-actions">
        <div className="spacer" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button className={kind === 'dropColumn' ? 'danger' : 'primary'}>{COLUMN_OPERATIONS[kind]}</button>
      </div>
    </form>
  )
}
