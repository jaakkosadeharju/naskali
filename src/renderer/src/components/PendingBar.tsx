const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export interface ChangeCounts {
  inserted: number
  updated: number
  deleted: number
}

/** e.g. "2 rows added, 1 row updated". */
export function summarize({ inserted, updated, deleted }: ChangeCounts): string {
  const parts: string[] = []
  if (inserted) parts.push(`${plural(inserted, 'row')} added`)
  if (updated) parts.push(`${plural(updated, 'row')} updated`)
  if (deleted) parts.push(`${plural(deleted, 'row')} deleted`)
  return parts.join(', ') || 'nothing'
}

interface Props {
  counts: ChangeCounts
  error: string | null
  saving: boolean
  onViewSql: () => void
  onCancel: () => void
  onAccept: () => void
  onDismissError: () => void
}

/** Staged changes with View SQL / Cancel / Accept, or the last save error. Renders nothing when there's neither. */
export function PendingBar({ counts, error, saving, onViewSql, onCancel, onAccept, onDismissError }: Props): JSX.Element | null {
  const changeCount = counts.inserted + counts.updated + counts.deleted
  if (changeCount === 0 && !error) return null
  return (
    <div className={`pending-bar ${error ? 'has-error' : ''}`}>
      {changeCount > 0 && <span>✎ Pending: {summarize(counts)}</span>}
      {error && <span className="pending-error">{error}</span>}
      <div className="spacer" />
      {changeCount > 0 && (
        <>
          <button onClick={onViewSql} disabled={saving}>
            View SQL
          </button>
          <button onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="primary" onClick={onAccept} disabled={saving}>
            {saving ? 'Saving…' : 'Accept'}
          </button>
        </>
      )}
      {changeCount === 0 && (
        <button className="icon" onClick={onDismissError} title="Dismiss">
          ✕
        </button>
      )}
    </div>
  )
}
