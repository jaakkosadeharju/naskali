// Bundle Monaco locally instead of letting @monaco-editor/react load it from a CDN:
// the app must work offline and the CSP only allows 'self'.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { conf, language } from 'monaco-editor/languages/definitions/mysql/mysql'
import { loader } from '@monaco-editor/react'
import type { DriverKind } from '../../shared/types'

self.MonacoEnvironment = {
  // SQL only needs the generic editor worker.
  getWorker: () => new EditorWorker()
}

loader.config({ monaco })

/**
 * Monaco's built-in `mysql` tokenizer lets `[^']+` swallow the backslash in
 * `'O\'Brien'`, ending the string early. Register a patched copy under our own
 * id (eagerly, so the built-in lazy loader can't override it).
 */
const MYSQL_LANG = 'naskali-mysql'
const stringRules = (q: string, token: string): monaco.languages.IMonarchLanguageRule[] => [
  [/\\./, token], // backslash escapes, e.g. \' \\ \n
  [new RegExp(`[^${q}\\\\]+`), token],
  [new RegExp(`${q}${q}`), token], // doubled-quote escape
  [new RegExp(q), { token, next: '@pop' }]
]
monaco.languages.register({ id: MYSQL_LANG, aliases: ['MySQL'] })
monaco.languages.setLanguageConfiguration(MYSQL_LANG, conf)
monaco.languages.setMonarchTokensProvider(MYSQL_LANG, {
  ...language,
  tokenizer: { ...language.tokenizer, string: stringRules("'", 'string'), stringDouble: stringRules('"', 'string.double') }
})

// Editor language per database: our patched MySQL, Monaco's PostgreSQL mode,
// and its generic (T-SQL flavoured) SQL mode for SQL Server and SQLite.
const LANGUAGE_BY_DRIVER: Record<DriverKind, string> = {
  mysql: MYSQL_LANG,
  postgres: 'pgsql',
  mssql: 'sql',
  sqlite: 'sql'
}
/** Every language id the SQL editor can use (autocomplete registers for all). */
export const SQL_LANGUAGES = [...new Set(Object.values(LANGUAGE_BY_DRIVER))]

let currentDriver: DriverKind = 'mysql'
let currentLanguage = MYSQL_LANG
/** The language for the connected database – for the editor and for colorizing SQL. */
export const editorLanguage = (): string => currentLanguage
/** The connected database type (e.g. for statement splitting rules). */
export const editorDriver = (): DriverKind => currentDriver

export function setEditorDialect(driver: DriverKind): void {
  currentDriver = driver
  currentLanguage = LANGUAGE_BY_DRIVER[driver]
  for (const model of monaco.editor.getModels()) monaco.editor.setModelLanguage(model, currentLanguage)
}

export { monaco }
