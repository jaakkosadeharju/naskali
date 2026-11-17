import { useEffect, useMemo, useState } from 'react'
import { isJsonType, parseJsonValue, type Json } from '../json'
import { JsonTree } from './JsonTree'
import { JsonHighlight } from './JsonHighlight'
import type { InspectedValue } from '../inspector'

type JsonMode = 'tree' | 'formatted' | 'raw'
const HIGHLIGHT_LIMIT = 300_000 // chars; beyond this, formatted JSON is shown unhighlighted

interface Props {
  item: InspectedValue | null
  onClose: () => void
  width: number
  onResize: (width: number) => void
}

export function ValueInspector({ item, onClose, width, onResize }: Props): JSX.Element {
  const [mode, setMode] = useState<JsonMode>('tree')
  const [expand, setExpand] = useState({ depth: 2, n: 0 }) // n bumps to remount the tree
  const [wrap, setWrap] = useState(true)

  const parsed = useMemo(
    () => (item && !item.isDefault ? parseJsonValue(item.value, isJsonType(item.type)) : { ok: false as const }),
    [item]
  )

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
        <span className="inspector-title">Value</span>
        <div className="spacer" />
        <button className="icon" onClick={onClose} title="Close (Ctrl+I)">
          ✕
        </button>
      </div>

      {!item ? (
        <div className="placeholder">
          Select a cell to preview its value.
          <br />
          <span className="muted">Ctrl+I toggles this panel · double-click a read-only cell to open it.</span>
        </div>
      ) : (
        <>
          <div className="inspector-meta">
            <span className="strong mono">{item.column}</span>
            <span className="inspector-type">{item.type}</span>
            <div className="muted inspector-source">{item.source}</div>
          </div>

          {item.isDefault ? (
            <div className="placeholder">
              <span className="mono">DEFAULT</span> – the column default (or auto_increment) will be used.
            </div>
          ) : item.value === null ? (
            <div className="placeholder">
              <span className="mono">NULL</span>
            </div>
          ) : parsed.ok ? (
            <JsonBody
              json={parsed.json}
              raw={String(item.value)}
              mode={mode}
              setMode={setMode}
              expand={expand}
              setExpand={setExpand}
            />
          ) : (
            <TextBody text={String(item.value)} wrap={wrap} setWrap={setWrap} />
          )}
        </>
      )}
    </aside>
  )
}

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
}

function JsonBody({ json, raw, mode, setMode, expand, setExpand }: JsonBodyProps): JSX.Element {
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
          <JsonTree key={expand.n} data={json} expandDepth={expand.depth} />
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
