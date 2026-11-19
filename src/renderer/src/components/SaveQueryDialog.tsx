import { useEffect, useRef, useState } from 'react'

interface Props {
  initialName?: string
  onSave: (name: string) => Promise<string | null>
  onClose: () => void
}

export function SaveQueryDialog({ initialName = '', onSave, onClose }: Props): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(initialName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => node?.close()
  }, [])

  return (
    <dialog ref={dialog} className="save-query-dialog" aria-labelledby="save-query-title" onCancel={(event) => {
      if (saving) event.preventDefault()
      else onClose()
    }}>
      <form className="dialog" onSubmit={async (event) => {
        event.preventDefault()
        if (!name.trim() || saving) return
        setSaving(true)
        setError(null)
        try {
          setError(await onSave(name.trim()))
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }}>
        <h2 id="save-query-title">Save query</h2>
        <label>
          Query name
          <input autoFocus required readOnly={saving} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {error && <div className="error" role="alert">Could not save the query. {error}</div>}
        <div className="dialog-actions">
          <button type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </dialog>
  )
}
