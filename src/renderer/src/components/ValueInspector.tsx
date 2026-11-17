import { useEffect, useMemo, useRef, useState } from 'react'
import { describeJsonError, isJsonType, parseJsonValue, serializeLike, setAtPath, type Json, type JsonKey } from '../json'
import { JsonTree } from './JsonTree'
import { JsonHighlight } from './JsonHighlight'
import type { InspectedValue } from '../inspector'
import type { CellValue } from '../../../shared/types'

type JsonMode = 'tree' | 'formatted' | 'raw'
const HIGHLIGHT_LIMIT = 300_000 // chars; beyond this, formatted JSON is shown unhighlighted

interface Props {
  item: InspectedValue | null
  onClose: () => void
  width: number
  onResize: (width: number) => void
}

/** An open text editor in the panel. It stays bound to `target` even if the grid selection moves. */
interface EditSession {
  target: InspectedValue
  draft: string
  /** Edit as JSON (validate, format, re-serialize) – for JSON columns and JSON-looking text. */
  json: boolean
}

export function ValueInspector({ item, onClose, width, onResize }: Props): JSX.Element {
  const [mode, setMode] = useState<JsonMode>('tree')
  const [expand, setExpand] = useState({ depth: 2, n: 0 }) // n bumps to remount the tree
  const [wrap, setWrap] = useState(true)
  const [edit, setEdit] = useState<EditSession | null>(null)

  // While editing, show the cell being edited, not whatever is selected now.
  const shown = edit?.target ?? item
  const jsonColumn = !!shown && isJsonType(shown.type)
  const parsed = useMemo(
    () => (shown && !shown.isDefault ? parseJsonValue(shown.value, jsonColumn) : { ok: false as const }),
    [shown, jsonColumn]
  )

  const startEdit = (): void => {
    if (!item?.onChange) return
    const p = item.isDefault ? ({ ok: false } as const) : parseJsonValue(item.value, isJsonType(item.type))
    setEdit({
      target: item,
      json: p.ok || isJsonType(item.type),
      draft: p.ok ? JSON.stringify(p.json, null, 2) : item.value === null || item.isDefault ? '' : String(item.value)
    })
  }

  /** Applies an edited JSON document to the shown cell, keeping the original's formatting style. */
  const commitJson = (target: InspectedValue, json: Json): void => {
    const original = target.value === null || target.isDefault ? '' : String(target.value)
    target.onChange?.(serializeLike(json, original, isJsonType(target.type)))
  }

  const onEditLeaf =
    shown?.onChange && parsed.ok && !edit
      ? (path: JsonKey[], v: Json) => commitJson(shown, setAtPath(parsed.json, path, v))
      : undefined

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const move = (ev: MouseEvent): void => onResize(window.innerWidth - ev.clientX)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <aside className="inspector" style={{ width }}>
      <div className="inspector-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="inspector-header">
        <span className="inspector-title">{edit ? 'Edit value' : 'Value'}</span>
        <div className="spacer" />
        <button className="icon" onClick={onClose} title="Close (Ctrl+I)">
          ✕
        </button>
      </div>

      {!shown ? (
        <div className="placeholder">
          Select a cell to preview its value.
          <br />
          <span className="muted">Ctrl+I toggles this panel · double-click a read-only cell to open it.</span>
        </div>
      ) : (
        <>
          <div className="inspector-meta">
            <span className="strong mono">{shown.column}</span>
            <span className="inspector-type">{shown.type}</span>
            {shown.edited && !edit && <span className="inspector-badge pending">● pending change</span>}
            {shown.readOnlyReason && <span className="inspector-badge">read-only · {shown.readOnlyReason}</span>}
            <div className="muted inspector-source">{shown.source}</div>
          </div>

          {edit ? (
            <ValueEditor
              session={edit}
              onDraft={(draft) => setEdit({ ...edit, draft })}
              onCancel={() => setEdit(null)}
              onApply={(value) => {
                edit.target.onChange?.(value)
                setEdit(null)
              }}
              commitJson={(json) => {
                commitJson(edit.target, json)
                setEdit(null)
              }}
            />
          ) : (
            <>
              {shown.onChange && (
                <div className="inspector-actions">
                  <button className="small" onClick={startEdit} title="Edit the whole value as text">
                    ✎ Edit
                  </button>
                  {shown.nullable && (shown.value !== null || shown.isDefault) && (
                    <button className="small" onClick={() => shown.onChange?.(null)}>
                      Set NULL
                    </button>
                  )}
                  {shown.onRevert && (
                    <button className="small" onClick={shown.onRevert} title="Drop this cell's pending change">
                      ↺ Revert
                    </button>
                  )}
                  {onEditLeaf && <span className="muted inspector-hint">or double-click a value in the tree</span>}
                </div>
              )}
              {shown.isDefault ? (
                <div className="placeholder">
                  <span className="mono">DEFAULT</span> – the column default (or auto_increment) will be used.
                </div>
              ) : shown.value === null ? (
                <div className="placeholder">
                  <span className="mono">NULL</span>
                </div>
              ) : parsed.ok ? (
                <JsonBody
                  json={parsed.json}
                  raw={String(shown.value)}
                  mode={mode}
                  setMode={setMode}
                  expand={expand}
                  setExpand={setExpand}
                  onEditLeaf={onEditLeaf}
                />
              ) : (
                <TextBody text={String(shown.value)} wrap={wrap} setWrap={setWrap} />
              )}
            </>
          )}
        </>
      )}
    </aside>
  )
}

// ---- Editor -------------------------------------------------------------------

interface EditorProps {
  session: EditSession
  onDraft: (draft: string) => void
  onCancel: () => void
  /** Store the draft text as-is. */
  onApply: (value: CellValue) => void
  /** Store parsed JSON (re-serialized in the original's style). */
  commitJson: (json: Json) => void
}

function ValueEditor({ session, onDraft, onCancel, onApply, commitJson }: EditorProps): JSX.Element {
  const { draft, json, target } = session
  const jsonColumn = isJsonType(target.type)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  const check = useMemo((): { ok: true; json: Json } | { ok: false; error: string } | null => {
    if (!json) return null
    try {
      return { ok: true, json: JSON.parse(draft) as Json }
    } catch {
      return { ok: false, error: describeJsonError(draft) }
    }
  }, [draft, json])

  // JSON columns must get valid JSON; JSON-looking text may be saved as plain text after a warning.
  const blocked = jsonColumn && check !== null && !check.ok
  const apply = (): void => {
    if (blocked) return
    if (check?.ok) commitJson(check.json)
    else onApply(draft)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation() // keep keys away from the grid and global shortcuts
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      apply()
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // Indent instead of leaving the field.
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = el
      onDraft(draft.slice(0, a) + '  ' + draft.slice(b))
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
    }
  }

  return (
    <>
      <div className="inspector-toolbar">
        {json && (
          <button className="small" disabled={!check?.ok} onClick={() => check?.ok && onDraft(JSON.stringify(check.json, null, 2))}>
            Format
          </button>
        )}
        {json && (
          <button className="small" disabled={!check?.ok} onClick={() => check?.ok && onDraft(JSON.stringify(check.json))} title="Single line">
            Minify
          </button>
        )}
        <div className="spacer" />
        <button className="small" onClick={onCancel} title="Esc">
          Cancel
        </button>
        <button className="small primary" onClick={apply} disabled={blocked} title="Ctrl+Enter">
          {check && !check.ok && !jsonColumn ? 'Apply as text' : 'Apply'}
        </button>
      </div>
      <div className={`inspector-stats ${check && !check.ok ? 'invalid' : 'muted'}`}>
        {check === null
          ? `${draft.length.toLocaleString()} chars · Ctrl+Enter applies, Esc cancels`
          : check.ok
            ? `✓ Valid JSON · ${draft.length.toLocaleString()} chars`
            : `✗ ${check.error}${jsonColumn ? '' : ' – will be saved as plain text'}`}
      </div>
      <div className="inspector-body">
        <textarea
          ref={ref}
          className="inspector-editor"
          value={draft}
          spellCheck={false}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="muted inspector-footnote">
        Applying stages a pending change – save it with Accept in the table view.
      </div>
    </>
  )
}

// ---- Viewers -------------------------------------------------------------------

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): JSX.Element {
  const [done, setDone] = useState(false)
  useEffect(() => {
    setDone(false)
  }, [text])
  return (
    <button className="small" onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}>
      {done ? 'Copied ✓' : label}
    </button>
  )
}

function describe(json: Json): string {
  if (Array.isArray(json)) return `array · ${json.length} item${json.length === 1 ? '' : 's'}`
  if (json !== null && typeof json === 'object') {
    const n = Object.keys(json).length
    return `object · ${n} key${n === 1 ? '' : 's'}`
  }
  return json === null ? 'null' : typeof json
}

interface JsonBodyProps {
  json: Json
  raw: string
  mode: JsonMode
  setMode: (m: JsonMode) => void
  expand: { depth: number; n: number }
  setExpand: (e: { depth: number; n: number }) => void
  onEditLeaf?: (path: JsonKey[], value: Json) => void
}

function JsonBody({ json, raw, mode, setMode, expand, setExpand, onEditLeaf }: JsonBodyProps): JSX.Element {
  const pretty = useMemo(() => JSON.stringify(json, null, 2), [json])

  return (
    <>
      <div className="inspector-toolbar">
        <div className="segmented">
          {(['tree', 'formatted', 'raw'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {m === 'tree' ? 'Tree' : m === 'formatted' ? 'Formatted' : 'Raw'}
            </button>
          ))}
        </div>
        {mode === 'tree' && (
          <>
            <button className="small" onClick={() => setExpand({ depth: Infinity, n: expand.n + 1 })} title="Expand all">
              ⊞
            </button>
            <button className="small" onClick={() => setExpand({ depth: 1, n: expand.n + 1 })} title="Collapse all">
              ⊟
            </button>
          </>
        )}
        <div className="spacer" />
        <CopyButton text={mode === 'raw' ? raw : pretty} />
      </div>
      <div className="muted inspector-stats">
        JSON {describe(json)} · {raw.length.toLocaleString()} chars
      </div>
      <div className="inspector-body">
        {mode === 'tree' ? (
          <JsonTree key={expand.n} data={json} expandDepth={expand.depth} onEditLeaf={onEditLeaf} />
        ) : mode === 'formatted' ? (
          <pre className="inspector-pre">{pretty.length > HIGHLIGHT_LIMIT ? pretty : <JsonHighlight text={pretty} />}</pre>
        ) : (
          <pre className="inspector-pre wrap">{raw}</pre>
        )}
      </div>
    </>
  )
}

function TextBody({ text, wrap, setWrap }: { text: string; wrap: boolean; setWrap: (w: boolean) => void }): JSX.Element {
  const lines = text.split('\n').length
  return (
    <>
      <div className="inspector-toolbar">
        <label className="check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <div className="spacer" />
        <CopyButton text={text} />
      </div>
      <div className="muted inspector-stats">
        {text.length.toLocaleString()} chars{lines > 1 ? ` · ${lines.toLocaleString()} lines` : ''}
      </div>
      <div className="inspector-body">
        <pre className={`inspector-pre ${wrap ? 'wrap' : ''}`}>{text}</pre>
      </div>
    </>
  )
}
