import { useMemo } from 'react'

// Minimal syntax highlighter for (pretty-printed) JSON. Renders React elements,
// so no HTML strings are injected, and reuses the JSON tree's color classes.

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}[\],])/g

export function JsonHighlight({ text }: { text: string }): JSX.Element {
  const parts = useMemo(() => {
    const out: JSX.Element[] = []
    let last = 0
    let i = 0
    for (const m of text.matchAll(TOKEN)) {
      if (m.index > last) out.push(<span key={i++}>{text.slice(last, m.index)}</span>)
      const [all, str, colon, num, bool, nul] = m
      if (str !== undefined && colon !== undefined) {
        out.push(<span key={i++} className="jt-key">{str}</span>, <span key={i++} className="jt-punct">{colon}</span>)
      } else if (str !== undefined) out.push(<span key={i++} className="jt-str">{str}</span>)
      else if (num !== undefined) out.push(<span key={i++} className="jt-num">{num}</span>)
      else if (bool !== undefined) out.push(<span key={i++} className="jt-bool">{bool}</span>)
      else if (nul !== undefined) out.push(<span key={i++} className="jt-null">{nul}</span>)
      else out.push(<span key={i++} className="jt-punct">{all}</span>)
      last = m.index + all.length
    }
    if (last < text.length) out.push(<span key={i++}>{text.slice(last)}</span>)
    return out
  }, [text])
  return <>{parts}</>
}
