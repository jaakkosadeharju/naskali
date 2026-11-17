// Bundle Monaco locally instead of letting @monaco-editor/react load it from a CDN:
// the app must work offline and the CSP only allows 'self'.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { conf, language } from 'monaco-editor/languages/definitions/mysql/mysql'
import { loader } from '@monaco-editor/react'

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
export const SQL_LANG = 'naskali-mysql'
const stringRules = (q: string, token: string): monaco.languages.IMonarchLanguageRule[] => [
  [/\\./, token], // backslash escapes, e.g. \' \\ \n
  [new RegExp(`[^${q}\\\\]+`), token],
  [new RegExp(`${q}${q}`), token], // doubled-quote escape
  [new RegExp(q), { token, next: '@pop' }]
]
monaco.languages.register({ id: SQL_LANG, aliases: ['MySQL'] })
monaco.languages.setLanguageConfiguration(SQL_LANG, conf)
monaco.languages.setMonarchTokensProvider(SQL_LANG, {
  ...language,
  tokenizer: { ...language.tokenizer, string: stringRules("'", 'string'), stringDouble: stringRules('"', 'string.double') }
})

export { monaco }
