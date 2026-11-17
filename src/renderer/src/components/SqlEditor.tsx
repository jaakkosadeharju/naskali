import Editor from '@monaco-editor/react'
import { useEffect, useRef } from 'react'
import { editorDriver, editorLanguage, monaco } from '../monacoSetup'
import { SPLIT_RULES, statementAt } from '../sqlSplit'

type CodeEditor = monaco.editor.IStandaloneCodeEditor

const DRAFT_KEY = 'naskali.draft'
const DEFAULT_SQL = `-- Ctrl+Enter runs the statement under the cursor (or the selection)
SELECT c.name, COUNT(*) AS orders, SUM(o.quantity * p.price) AS revenue
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN products p ON p.id = o.product_id
GROUP BY c.id
ORDER BY revenue DESC
LIMIT 50;

SELECT * FROM orders;
`

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? DEFAULT_SQL
  } catch {
    return DEFAULT_SQL
  }
}

/** The selection if there is one, otherwise the statement under the cursor; flashes it. */
export function sqlToRun(editor: CodeEditor): string | null {
  const model = editor.getModel()
  const sel = editor.getSelection()
  if (!model || !sel) return null
  let range: monaco.IRange
  if (!sel.isEmpty()) {
    range = sel
  } else {
    const stmt = statementAt(model.getValue(), model.getOffsetAt(sel.getPosition()), SPLIT_RULES[editorDriver()])
    if (!stmt) return null
    const s = model.getPositionAt(stmt.start)
    const e = model.getPositionAt(stmt.end)
    range = new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column)
  }
  const deco = editor.createDecorationsCollection([{ range, options: { className: 'executed-range' } }])
  setTimeout(() => deco.clear(), 400)
  return model.getValueInRange(range).trim() || null
}

interface Props {
  onMount: (editor: CodeEditor) => void
  onRun: () => void
}

export function SqlEditor({ onMount, onRun }: Props): JSX.Element {
  // Monaco commands are registered once, so call through a ref to see the latest handler.
  const onRunRef = useRef(onRun)
  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])

  return (
    <Editor
      defaultLanguage={editorLanguage()}
      defaultValue={loadDraft()}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordBasedSuggestions: 'off',
        tabSize: 2
      }}
      onChange={(v) => {
        try {
          localStorage.setItem(DRAFT_KEY, v ?? '')
        } catch {
          /* storage unavailable: drafts just won't persist */
        }
      }}
      onMount={(editor) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current())
        editor.focus()
        onMount(editor)
      }}
    />
  )
}
