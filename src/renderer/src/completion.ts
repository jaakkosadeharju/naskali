import { monaco, SQL_LANG } from './monacoSetup'
import type { SchemaInfo, TableInfo } from '../../shared/types'

// Schema-aware autocomplete. The provider is registered once; the app pushes
// fresh metadata into `completionState` whenever it (re)introspects.

export const completionState: { schemas: SchemaInfo[]; currentDb: string | null } = {
  schemas: [],
  currentDb: null
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN', 'ON', 'USING', 'AS', 'DISTINCT',
  'GROUP BY', 'HAVING', 'ORDER BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'WITH',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'REPLACE INTO', 'ON DUPLICATE KEY UPDATE',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'CREATE INDEX', 'CREATE VIEW',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'DEFAULT', 'AUTO_INCREMENT', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'SHOW TABLES', 'SHOW DATABASES', 'DESCRIBE', 'EXPLAIN', 'USE', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'OVER', 'PARTITION BY', 'WINDOW'
]
const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'COALESCE', 'IFNULL', 'NULLIF', 'IF',
  'CONCAT', 'CONCAT_WS', 'SUBSTRING', 'LENGTH', 'CHAR_LENGTH', 'LOWER', 'UPPER', 'TRIM', 'REPLACE',
  'NOW', 'CURDATE', 'DATE', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'YEAR', 'MONTH', 'DAY',
  'ROUND', 'FLOOR', 'CEIL', 'ABS', 'CAST', 'CONVERT', 'JSON_EXTRACT', 'JSON_OBJECT', 'JSON_ARRAY',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD'
]

const unquote = (s: string): string => s.replace(/`/g, '')

function findTable(name: string, schema?: string): TableInfo | undefined {
  const lname = name.toLowerCase()
  const inSchema = (s: SchemaInfo): TableInfo | undefined => s.tables.find((t) => t.name.toLowerCase() === lname)
  const { schemas, currentDb } = completionState
  if (schema) {
    const s = schemas.find((x) => x.name.toLowerCase() === schema.toLowerCase())
    return s && inSchema(s)
  }
  const cur = schemas.find((s) => s.name === currentDb)
  return (cur && inSchema(cur)) ?? schemas.map(inSchema).find(Boolean)
}

/** Maps aliases (and bare table names) used in FROM/JOIN clauses to tables. */
function tablesInQuery(sql: string): Map<string, TableInfo> {
  const refs = new Map<string, TableInfo>()
  const re = /\b(?:from|join|update|into)\s+((?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?)(?:\s+(?:as\s+)?(`[^`]+`|\w+))?/gi
  const notAlias = new Set(['where', 'on', 'using', 'join', 'inner', 'left', 'right', 'cross', 'group', 'order', 'limit', 'set', 'values', 'natural'])
  for (const m of sql.matchAll(re)) {
    const parts = m[1].split('.').map(unquote)
    const table = parts.length === 2 ? findTable(parts[1], parts[0]) : findTable(parts[0])
    if (!table) continue
    refs.set(table.name.toLowerCase(), table)
    const alias = m[2] && unquote(m[2])
    if (alias && !notAlias.has(alias.toLowerCase())) refs.set(alias.toLowerCase(), table)
  }
  return refs
}

monaco.languages.registerCompletionItemProvider(SQL_LANG, {
  triggerCharacters: ['.'],
  provideCompletionItems(model, position) {
    const K = monaco.languages.CompletionItemKind
    const word = model.getWordUntilPosition(position)
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
    const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn))
    const { schemas, currentDb } = completionState
    const refs = tablesInQuery(model.getValue())

    const columnItems = (t: TableInfo, sortPrefix: string): monaco.languages.CompletionItem[] =>
      t.columns.map((c) => ({
        label: { label: c.name, description: c.type, detail: c.key === 'PRI' ? ' 🔑' : undefined },
        kind: K.Field,
        insertText: c.name,
        detail: `${t.name}.${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`,
        sortText: sortPrefix + c.name,
        range
      }))
    const tableItems = (s: SchemaInfo, sortPrefix: string): monaco.languages.CompletionItem[] =>
      s.tables.map((t) => ({
        label: { label: t.name, description: t.type === 'VIEW' ? 'view' : 'table' },
        kind: t.type === 'VIEW' ? K.Interface : K.Struct,
        insertText: t.name,
        detail: `${s.name}.${t.name}`,
        sortText: sortPrefix + t.name,
        range
      }))

    // Qualified: `schema.` → tables, `table.` / `alias.` → columns.
    const qual = /(`[^`]+`|\w+)\.$/.exec(before)
    if (qual) {
      const q = unquote(qual[1]).toLowerCase()
      const schema = schemas.find((s) => s.name.toLowerCase() === q)
      if (schema) return { suggestions: tableItems(schema, '0') }
      const table = refs.get(q) ?? findTable(q)
      return { suggestions: table ? columnItems(table, '0') : [] }
    }

    const suggestions: monaco.languages.CompletionItem[] = []
    // Columns of tables referenced in the editor come first.
    for (const t of new Set(refs.values())) suggestions.push(...columnItems(t, '0'))
    const cur = schemas.find((s) => s.name === currentDb)
    if (cur) suggestions.push(...tableItems(cur, '1'))
    for (const s of schemas) {
      suggestions.push({ label: s.name, kind: K.Module, insertText: s.name, detail: 'database', sortText: '2' + s.name, range })
    }
    for (const k of KEYWORDS) suggestions.push({ label: k, kind: K.Keyword, insertText: k, sortText: '3' + k, range })
    for (const f of FUNCTIONS) {
      suggestions.push({
        label: f,
        kind: K.Function,
        insertText: `${f}($0)`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        sortText: '4' + f,
        range
      })
    }
    return { suggestions }
  }
})
