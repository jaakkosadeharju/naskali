import { useEffect, useState } from 'react'
import { monaco, SQL_LANG } from '../monacoSetup'

interface Props {
  title: string
  statements: string[]
  onClose: () => void
  onOpenInEditor: (sql: string) => void
}

export function SqlPreviewModal({ title, statements, onClose, onOpenInEditor }: Props): JSX.Element {
  const sql = statements.join('\n')
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    // colorize() escapes the text itself, so its HTML output is safe to inject.
    void monaco.editor.colorize(sql, SQL_LANG, {}).then((h) => live && setHtml(h))
    return () => {
      live = false
    }
  }, [sql])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog sql-preview-dialog" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {html === null ? <pre className="ddl">{sql}</pre> : <pre className="ddl" dangerouslySetInnerHTML={{ __html: html }} />}
        <div className="dialog-actions">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(sql).then(() => setCopied(true))
            }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button
            onClick={() => {
              onOpenInEditor(sql)
              onClose()
            }}
          >
            Open in editor
          </button>
          <div className="spacer" />
          <button className="primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
