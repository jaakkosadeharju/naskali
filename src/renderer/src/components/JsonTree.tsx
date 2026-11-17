import { useState } from 'react'
import { parseLeafInput, parseNestedJson, type Json, type JsonKey } from '../json'

const CHILD_LIMIT = 200

interface Props {
  data: Json
  /** Levels expanded initially (remount with a new `key` to re-apply, e.g. expand/collapse all). */
  expandDepth: number
  /** Enables double-click editing of leaf values. */
  onEditLeaf?: (path: JsonKey[], value: Json) => void
}

export function JsonTree({ data, expandDepth, onEditLeaf }: Props): JSX.Element {
  return (
    <div className={`json-tree ${onEditLeaf ? 'editable' : ''}`} role="tree">
      <JsonNode name={null} value={data} depth={0} path="$" keys={[]} expandDepth={expandDepth} onEditLeaf={onEditLeaf} />
    </div>
  )
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text)
}

interface NodeProps {
  name: string | number | null
  value: Json
  depth: number
  /** Display path, e.g. $.items[0].sku */
  path: string
  /** The same path as keys, for editing. */
  keys: JsonKey[]
  expandDepth: number
  onEditLeaf?: (path: JsonKey[], value: Json) => void
}

function JsonNode({ name, value, depth, path, keys, expandDepth, onEditLeaf }: NodeProps): JSX.Element {
  // A string that holds JSON is shown as an expandable node of its parsed value.
  const nested = typeof value === 'string' ? parseNestedJson(value) : null
  const container = nested ?? (value !== null && typeof value === 'object' ? value : null)
  const [open, setOpen] = useState(depth < expandDepth)
  const [limit, setLimit] = useState(CHILD_LIMIT)

  const key =
    name === null ? null : typeof name === 'number' ? (
      <span className="jt-index">{name}</span>
    ) : (
      <span className="jt-key">{JSON.stringify(name)}</span>
    )
  const copyBtn = (
    <button
      className="jt-copy"
      title={`Copy value (${path})`}
      onClick={(e) => {
        e.stopPropagation()
        copy(typeof value === 'string' && !nested ? value : JSON.stringify(nested ?? value, null, 2))
      }}
    >
      ⧉
    </button>
  )

  if (!container) {
    return (
      <div className="jt-row" title={onEditLeaf ? `${path} – double-click to edit` : path} role="treeitem">
        <span className="jt-twisty" />
        {key}
        {key && <span className="jt-punct">: </span>}
        {onEditLeaf ? (
          <EditableLeaf value={value} onCommit={(v) => onEditLeaf(keys, v)} />
        ) : (
          <Primitive value={value} />
        )}
        {copyBtn}
      </div>
    )
  }

  const isArray = Array.isArray(container)
  const entries: [string | number, Json][] = isArray
    ? (container as Json[]).map((v, i) => [i, v])
    : Object.entries(container as Record<string, Json>)
  const summary = isArray ? `[ ${entries.length} item${entries.length === 1 ? '' : 's'} ]` : `{ ${entries.length} key${entries.length === 1 ? '' : 's'} }`

  return (
    <div role="treeitem" aria-expanded={open}>
      <div className="jt-row jt-branch" title={path} onClick={() => setOpen(!open)}>
        <span className="jt-twisty">{entries.length ? (open ? '▾' : '▸') : ''}</span>
        {key}
        {key && <span className="jt-punct">: </span>}
        {nested && <span className="jt-badge" title="This string contains JSON; shown parsed">JSON string</span>}
        <span className="jt-summary">{open && entries.length ? (isArray ? '[' : '{') : summary}</span>
        {copyBtn}
      </div>
      {open && entries.length > 0 && (
        <div className="jt-children" role="group">
          {entries.slice(0, limit).map(([k, v]) => (
            <JsonNode
              key={k}
              name={k}
              value={v}
              depth={depth + 1}
              path={childPath(path, k)}
              keys={[...keys, k]}
              expandDepth={expandDepth}
              onEditLeaf={onEditLeaf}
            />
          ))}
          {entries.length > limit && (
            <button className="jt-more" onClick={() => setLimit(limit + CHILD_LIMIT)}>
              Show {Math.min(CHILD_LIMIT, entries.length - limit)} more of {entries.length - limit} remaining…
            </button>
          )}
          <div className="jt-row jt-close">
            <span className="jt-twisty" />
            <span className="jt-summary">{isArray ? ']' : '}'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function Primitive({ value }: { value: Json }): JSX.Element {
  if (value === null) return <span className="jt-null">null</span>
  if (typeof value === 'boolean') return <span className="jt-bool">{String(value)}</span>
  if (typeof value === 'number') return <span className="jt-num">{String(value)}</span>
  return <span className="jt-str">{JSON.stringify(value)}</span>
}

/** A primitive that turns into an input on double-click. Enter/blur commits, Escape cancels. */
function EditableLeaf({ value, onCommit }: { value: Json; onCommit: (v: Json) => void }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <span className="jt-editable" onDoubleClick={() => setDraft(typeof value === 'string' ? value : JSON.stringify(value))}>
        <Primitive value={value} />
      </span>
    )
  }
  const parsed = parseLeafInput(draft, value)
  const finish = (commit: boolean): void => {
    if (commit && parsed.ok && JSON.stringify(parsed.value) !== JSON.stringify(value)) onCommit(parsed.value)
    setDraft(null)
  }
  return (
    <input
      className={`jt-input ${parsed.ok ? '' : 'invalid'}`}
      value={draft}
      autoFocus
      title={parsed.ok ? (typeof value === 'string' ? 'Text – no quotes needed' : 'Enter to apply, Esc to cancel') : parsed.error}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(parsed.ok)}
      onKeyDown={(e) => {
        e.stopPropagation() // keep Enter/Escape/Delete away from the grid and global shortcuts
        if (e.key === 'Enter' && parsed.ok) finish(true)
        if (e.key === 'Escape') finish(false)
      }}
    />
  )
}
