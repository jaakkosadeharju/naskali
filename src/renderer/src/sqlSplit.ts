import type { DriverKind } from '../../shared/types'

export interface Statement {
  text: string
  start: number // offset of first non-whitespace char
  end: number // offset just past the statement (excluding the `;`)
}

/** Lexical rules that decide where a `;` really ends a statement. */
export interface SplitRules {
  /** `#` starts a line comment (MySQL; in PostgreSQL `#` is an operator). */
  hashComments: boolean
  /** `\` escapes inside quoted strings (MySQL; standard SQL strings have none). */
  backslashEscapes: boolean
  /** `-- ` needs whitespace after the dashes to be a comment (MySQL). */
  dashDashNeedsSpace: boolean
  /** `$$ … $$` / `$tag$ … $tag$` strings (PostgreSQL function bodies). */
  dollarQuotes: boolean
  /** `[identifier]` quoting (SQL Server). */
  brackets: boolean
}

export const SPLIT_RULES: Record<DriverKind, SplitRules> = {
  mysql: { hashComments: true, backslashEscapes: true, dashDashNeedsSpace: true, dollarQuotes: false, brackets: false },
  postgres: { hashComments: false, backslashEscapes: false, dashDashNeedsSpace: false, dollarQuotes: true, brackets: false },
  mssql: { hashComments: false, backslashEscapes: false, dashDashNeedsSpace: false, dollarQuotes: false, brackets: true },
  sqlite: { hashComments: false, backslashEscapes: false, dashDashNeedsSpace: false, dollarQuotes: false, brackets: true }
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/

/**
 * Splits SQL on `;`, ignoring semicolons inside quotes ('', "", `` plus
 * per-dialect $$…$$ and [..]) and comments. Doesn't handle MySQL `DELIMITER`
 * blocks or SQL Server `GO` separators.
 */
export function splitStatements(sql: string, rules: SplitRules = SPLIT_RULES.mysql): Statement[] {
  const out: Statement[] = []
  let segStart = 0
  let i = 0
  const push = (endExclusive: number): void => {
    const raw = sql.slice(segStart, endExclusive)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && !isOnlyComments(text, rules)) out.push({ text, start: segStart + lead, end: segStart + lead + text.length })
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < sql.length && sql[i] !== ch) {
        if (rules.backslashEscapes && sql[i] === '\\' && ch !== '`') i++
        i++
      }
      i++ // a doubled quote ('') simply closes and reopens
    } else if (rules.brackets && ch === '[') {
      const close = sql.indexOf(']', i + 1)
      i = close === -1 ? sql.length : close + 1
    } else if (rules.dollarQuotes && ch === '$' && DOLLAR_TAG.test(sql.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))![0]
      const close = sql.indexOf(tag, i + tag.length)
      i = close === -1 ? sql.length : close + tag.length
    } else if ((ch === '-' && next === '-' && (!rules.dashDashNeedsSpace || /\s/.test(sql[i + 2] ?? ' '))) || (rules.hashComments && ch === '#')) {
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

function isOnlyComments(text: string, rules: SplitRules): boolean {
  const lineComment = rules.hashComments ? /(--\s|#).*$/gm : /--.*$/gm
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(lineComment, '').trim() === ''
}

/** The statement containing the cursor, or the closest one before it. */
export function statementAt(sql: string, offset: number, rules?: SplitRules): Statement | null {
  const stmts = splitStatements(sql, rules)
  let best: Statement | null = null
  for (const s of stmts) {
    if (s.start <= offset) best = s
    if (offset <= s.end + 1 && offset >= s.start) return s
  }
  return best ?? stmts[0] ?? null
}
