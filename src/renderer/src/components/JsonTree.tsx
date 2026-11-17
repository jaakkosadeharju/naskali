import { useState } from 'react'
import { parseNestedJson, type Json } from '../json'

const CHILD_LIMIT = 200

interface Props {
  data: Json
  /** Levels expanded initially (remount with a new `key` to re-apply, e.g. expand/collapse all). */
  expandDepth: number
}

export function JsonTree({ data, expandDepth }: Props): JSX.Element {
  return (
    <div className="json-tree" role="tree">
      <JsonNode name={null} value={data} depth={0} path="$" expandDepth={expandDepth} />
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
  path: string
  expandDepth: number
}

function JsonNode({ name, value, depth, path, expandDepth }: NodeProps): JSX.Element {
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
      <div className="jt-row" title={path} role="treeitem">
        <span className="jt-twisty" />
        {key}
        {key && <span className="jt-punct">: </span>}
        <Primitive value={value} />
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
            <JsonNode key={k} name={k} value={v} depth={depth + 1} path={childPath(path, k)} expandDepth={expandDepth} />
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
