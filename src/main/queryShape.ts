import { SPLIT_RULES, sqlTokens, type SplitRules, type SqlToken } from '../shared/sqlSplit'

// What a query reads, from its text alone. Drivers name the table behind each
// result column but not which reference to that table it came through, so a
// table read twice (a self-join, or a subquery on the same table) can't have
// its rows addressed by the result's key. Errs towards counting too much.

export interface QueryShape {
  /** How often each name is read in FROM and JOIN clauses: tables, views and CTEs, by lower-case name. */
  reads: Map<string, number>
  /** Names defined by WITH, lower-case. */
  ctes: Set<string>
  /** UNION, INTERSECT or EXCEPT anywhere in the query. */
  setOperation: boolean
}

const SET_OPERATIONS = new Set(['union', 'intersect', 'except'])
const READ_KEYWORDS = new Set(['from', 'join', 'straight_join'])
/** Clauses after a FROM list, where commas no longer separate tables. */
const FROM_LIST_END = new Set(['where', 'group', 'having', 'order', 'limit', 'offset', 'fetch', 'window', 'qualify', 'for', 'into', 'union', 'intersect', 'except'])
/** Words between FROM/JOIN and the table name. */
const TABLE_PREFIXES = new Set(['only', 'lateral'])

const wordOf = (t: SqlToken | undefined): string | undefined => (t?.kind === 'word' ? t.text.toLowerCase() : undefined)
const isSymbol = (t: SqlToken | undefined, text: string): boolean => t?.kind === 'symbol' && t.text === text
const isName = (t: SqlToken | undefined): t is SqlToken => t?.kind === 'word' || t?.kind === 'identifier'

export function queryShape(sql: string, rules: SplitRules = SPLIT_RULES.mysql): QueryShape {
  const tokens = sqlTokens(sql, rules)
  const reads = new Map<string, number>()
  const ctes = new Set<string>()
  let setOperation = false
  /** Whether commas separate tables, per parenthesis depth. */
  const inFromList = [false]

  /** Index just past the parenthesis group opening at `i`. */
  const skipGroup = (i: number): number => {
    for (let depth = 0; i < tokens.length; i++) {
      if (isSymbol(tokens[i], '(')) depth++
      else if (isSymbol(tokens[i], ')') && --depth === 0) return i + 1
    }
    return i
  }

  /** Counts the table named at `i`; subqueries and table functions aren't tables. */
  const readTable = (i: number): void => {
    while (TABLE_PREFIXES.has(wordOf(tokens[i]) ?? '')) i++
    let name: string | undefined
    while (isName(tokens[i])) {
      name = tokens[i].text.toLowerCase()
      if (!isSymbol(tokens[i + 1], '.')) break
      i += 2
    }
    if (!name || isSymbol(tokens[i + 1], '(')) return
    reads.set(name, (reads.get(name) ?? 0) + 1)
  }

  /** Whether `i` names a CTE: `[WITH [RECURSIVE] | ,] name [(columns)] AS [NOT] [MATERIALIZED] (`. */
  const definesCte = (i: number): boolean => {
    const before = tokens[i - 1]
    if (!isName(tokens[i]) || !(isSymbol(before, ',') || wordOf(before) === 'with' || wordOf(before) === 'recursive')) return false
    let j = isSymbol(tokens[i + 1], '(') ? skipGroup(i + 1) : i + 1
    if (wordOf(tokens[j++]) !== 'as') return false
    if (wordOf(tokens[j]) === 'not') j++
    if (wordOf(tokens[j]) === 'materialized') j++
    return isSymbol(tokens[j], '(')
  }

  tokens.forEach((t, i) => {
    const depth = inFromList.length - 1
    if (isSymbol(t, '(')) inFromList.push(false)
    else if (isSymbol(t, ')')) {
      if (depth > 0) inFromList.pop()
    } else if (isSymbol(t, ',') && inFromList[depth]) readTable(i + 1)

    const word = wordOf(t)
    if (word && SET_OPERATIONS.has(word)) setOperation = true
    if (word && READ_KEYWORDS.has(word)) {
      inFromList[depth] = true
      readTable(i + 1)
    } else if (word && FROM_LIST_END.has(word)) inFromList[depth] = false
    if (definesCte(i)) ctes.add(t.text.toLowerCase())
  })
  return { reads, ctes, setOperation }
}
