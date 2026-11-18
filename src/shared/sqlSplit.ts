import type { DriverKind } from './types'

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
 * The SQL with every quoted string/identifier replaced by `_` and every comment
 * by spaces, keeping offsets: what is left is code a keyword search can trust.
 */
export function maskSql(sql: string, rules: SplitRules = SPLIT_RULES.mysql): string {
  let out = ''
  let i = 0
  const skip = (end: number, fill: string): void => {
    out += fill.repeat(end - i)
    i = end
  }
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length && sql[j] !== ch) {
        if (rules.backslashEscapes && sql[j] === '\\' && ch !== '`') j++
        j++
      }
      // A doubled quote ('') simply closes and reopens.
      skip(Math.min(j + 1, sql.length), '_')
    } else if (rules.brackets && ch === '[') {
      const close = sql.indexOf(']', i + 1)
      skip(close === -1 ? sql.length : close + 1, '_')
    } else if (rules.dollarQuotes && ch === '$' && DOLLAR_TAG.test(sql.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))![0]
      const close = sql.indexOf(tag, i + tag.length)
      skip(close === -1 ? sql.length : close + tag.length, '_')
    } else if ((ch === '-' && next === '-' && (!rules.dashDashNeedsSpace || /\s/.test(sql[i + 2] ?? ' '))) || (rules.hashComments && ch === '#')) {
      const close = sql.indexOf('\n', i)
      skip(close === -1 ? sql.length : close, ' ')
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      skip(close === -1 ? sql.length : close + 2, ' ')
    } else {
      out += ch
      i++
    }
  }
  return out
}

/**
 * Splits SQL on `;`, ignoring semicolons inside quotes ('', "", `` plus
 * per-dialect $$…$$ and [..]) and comments. Doesn't handle MySQL `DELIMITER`
 * blocks or SQL Server `GO` separators.
 */
export function splitStatements(sql: string, rules: SplitRules = SPLIT_RULES.mysql): Statement[] {
  const masked = maskSql(sql, rules)
  const out: Statement[] = []
  let segStart = 0
  const push = (endExclusive: number): void => {
    // Comment-only segments are blank once masked.
    if (masked.slice(segStart, endExclusive).trim() === '') return
    const raw = sql.slice(segStart, endExclusive)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    out.push({ text, start: segStart + lead, end: segStart + lead + text.length })
  }
  for (let i = masked.indexOf(';'); i !== -1; i = masked.indexOf(';', segStart)) {
    push(i)
    segStart = i + 1
  }
  push(sql.length)
  return out
}

/** Keywords that make a statement write data, create objects or run code. */
const WRITE_KEYWORDS = /\b(?:INSERT|UPDATE|DELETE|MERGE|INTO|CALL|EXEC|EXECUTE)\b/i

/**
 * True for a single statement that only reads: it starts with SELECT, WITH or
 * TABLE and has no writing keyword outside strings and comments (which rules out
 * data-modifying CTEs, SELECT … INTO and procedure calls). Such a query is safe
 * to run again, e.g. after saving edits made to its results.
 */
export function isPlainSelect(sql: string, rules: SplitRules = SPLIT_RULES.mysql): boolean {
  const statements = splitStatements(sql, rules)
  if (statements.length !== 1) return false
  const code = maskSql(statements[0].text, rules).replace(/\bFOR\s+UPDATE\b/gi, '')
  return /^\s*(?:SELECT|WITH|TABLE)\b/i.test(code) && !WRITE_KEYWORDS.test(code)
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
