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

interface Segment {
  kind: 'code' | 'quoted' | 'comment'
  start: number
  end: number
}

/** Index just past a quoted run opened at `i`; a doubled closing quote ('' or ]]) escapes it. */
function quotedEnd(sql: string, i: number, close: string, backslashEscapes: boolean): number {
  let j = i + 1
  for (;;) {
    while (j < sql.length && sql[j] !== close) {
      if (backslashEscapes && sql[j] === '\\') j++
      j++
    }
    if (j >= sql.length) return sql.length
    if (sql[j + 1] !== close) return j + 1
    j += 2
  }
}

/** Cuts SQL into code, quoted strings/identifiers and comments. */
function lex(sql: string, rules: SplitRules): Segment[] {
  const out: Segment[] = []
  let codeStart = 0
  let i = 0
  const take = (kind: Segment['kind'], end: number): void => {
    if (codeStart < i) out.push({ kind: 'code', start: codeStart, end: i })
    out.push({ kind, start: i, end })
    i = codeStart = end
  }
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'" || ch === '"' || ch === '`') {
      take('quoted', quotedEnd(sql, i, ch, rules.backslashEscapes && ch !== '`'))
    } else if (rules.brackets && ch === '[') {
      take('quoted', quotedEnd(sql, i, ']', false))
    } else if (rules.dollarQuotes && ch === '$' && DOLLAR_TAG.test(sql.slice(i, i + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))![0]
      const close = sql.indexOf(tag, i + tag.length)
      take('quoted', close === -1 ? sql.length : close + tag.length)
    } else if ((ch === '-' && next === '-' && (!rules.dashDashNeedsSpace || /\s/.test(sql[i + 2] ?? ' '))) || (rules.hashComments && ch === '#')) {
      const close = sql.indexOf('\n', i)
      take('comment', close === -1 ? sql.length : close)
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      take('comment', close === -1 ? sql.length : close + 2)
    } else {
      i++
    }
  }
  if (codeStart < sql.length) out.push({ kind: 'code', start: codeStart, end: sql.length })
  return out
}

/**
 * The SQL with every quoted string/identifier replaced by `_` and every comment
 * by spaces, keeping offsets: what is left is code a keyword search can trust.
 */
export function maskSql(sql: string, rules: SplitRules = SPLIT_RULES.mysql): string {
  return lex(sql, rules)
    .map((s) => (s.kind === 'code' ? sql.slice(s.start, s.end) : (s.kind === 'quoted' ? '_' : ' ').repeat(s.end - s.start)))
    .join('')
}

export interface SqlToken {
  /** `identifier` is a quoted name, unquoted; `string` keeps its quotes. */
  kind: 'word' | 'identifier' | 'string' | 'symbol'
  text: string
}

const CODE_TOKEN = /[\p{L}\p{N}_$@#]+|\S/gu

function unquote(raw: string): string {
  const close = raw[0] === '[' ? ']' : raw[0]
  const inner = raw.length > 1 && raw.endsWith(close) ? raw.slice(1, -1) : raw.slice(1)
  return inner.split(close + close).join(close)
}

/** The SQL's words, quoted names, strings and symbols, without whitespace and comments. */
export function sqlTokens(sql: string, rules: SplitRules = SPLIT_RULES.mysql): SqlToken[] {
  const out: SqlToken[] = []
  for (const s of lex(sql, rules)) {
    const text = sql.slice(s.start, s.end)
    if (s.kind === 'quoted') {
      // MySQL's default "…" strings are taken as names too; only names matter to callers.
      if (text[0] === '"' || text[0] === '`' || text[0] === '[') out.push({ kind: 'identifier', text: unquote(text) })
      else out.push({ kind: 'string', text })
    } else if (s.kind === 'code') {
      for (const [m] of text.matchAll(CODE_TOKEN)) out.push({ kind: m.length > 1 || /[\p{L}\p{N}_$@#]/u.test(m) ? 'word' : 'symbol', text: m })
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
