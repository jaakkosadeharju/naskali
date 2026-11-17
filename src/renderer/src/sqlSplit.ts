export interface Statement {
  text: string
  start: number // offset of first non-whitespace char
  end: number // offset just past the statement (excluding the `;`)
}

/**
 * Splits SQL on `;`, ignoring semicolons inside quotes ('', "", ``) and
 * comments (`-- `, `#`, `/* *\/`). Does not handle `DELIMITER` blocks.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
  let segStart = 0
  let i = 0
  const push = (endExclusive: number): void => {
    const raw = sql.slice(segStart, endExclusive)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && !isOnlyComments(text)) out.push({ text, start: segStart + lead, end: segStart + lead + text.length })
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < sql.length && sql[i] !== ch) {
        if (sql[i] === '\\' && ch !== '`') i++
        i++
      }
      i++
    } else if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close === -1 ? sql.length : close + 2
    } else if (ch === ';') {
      push(i)
      segStart = ++i
    } else {
      i++
    }
  }
  push(sql.length)
  return out
}

function isOnlyComments(text: string): boolean {
  return (
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(--\s|#).*$/gm, '')
      .trim() === ''
  )
}

/** The statement containing the cursor, or the closest one before it. */
export function statementAt(sql: string, offset: number): Statement | null {
  const stmts = splitStatements(sql)
  let best: Statement | null = null
  for (const s of stmts) {
    if (s.start <= offset) best = s
    if (offset <= s.end + 1 && offset >= s.start) return s
  }
  return best ?? stmts[0] ?? null
}
