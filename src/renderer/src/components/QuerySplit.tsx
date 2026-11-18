import { useRef, type ReactNode } from 'react'

const MIN_SHARE = 20
const MAX_SHARE = 80
const KEY_STEP = 4

interface Props {
  hidden: boolean
  share: number
  onResize: (share: number) => void
  editor: ReactNode
  results: ReactNode
}

export function QuerySplit({ hidden, share, onResize, editor, results }: Props): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; y: number; share: number; height: number } | null>(null)
  const resize = (value: number): void => {
    const next = Math.max(MIN_SHARE, Math.min(MAX_SHARE, Math.round(value)))
    if (next !== share) onResize(next)
  }

  return (
    <div
      className="tab-panel query-panel"
      hidden={hidden}
      ref={panel}
      style={{ gridTemplateRows: `minmax(0, ${share}fr) 7px minmax(0, ${100 - share}fr)` }}
    >
      <section className="editor" aria-label="SQL editor">{editor}</section>
      <div
        className="query-splitter"
        role="separator"
        tabIndex={0}
        aria-label="Resize SQL editor and results"
        aria-orientation="horizontal"
        aria-valuemin={MIN_SHARE}
        aria-valuemax={MAX_SHARE}
        aria-valuenow={share}
        aria-valuetext={`SQL editor ${share}%`}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary || !panel.current) return
          const height = panel.current.clientHeight - e.currentTarget.offsetHeight
          if (height <= 0) return
          e.preventDefault()
          e.currentTarget.focus()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { pointerId: e.pointerId, y: e.clientY, share, height }
        }}
        onPointerMove={(e) => {
          const start = drag.current
          if (start?.pointerId === e.pointerId) resize(start.share + 100 * (e.clientY - start.y) / start.height)
        }}
        onLostPointerCapture={(e) => {
          if (drag.current?.pointerId === e.pointerId) drag.current = null
        }}
        onKeyDown={(e) => {
          let next: number
          switch (e.key) {
            case 'ArrowUp':
              next = share - KEY_STEP
              break
            case 'ArrowDown':
              next = share + KEY_STEP
              break
            case 'Home':
              next = MIN_SHARE
              break
            case 'End':
              next = MAX_SHARE
              break
            default: return
          }
          e.preventDefault()
          resize(next)
        }}
      />
      <section className="results" aria-label="Query results">{results}</section>
    </div>
  )
}
