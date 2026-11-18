import Editor from '@monaco-editor/react'
import { useEffect, useRef } from 'react'
import { editorDriver, editorLanguage, monaco } from '../monacoSetup'
import { SPLIT_RULES, statementAt } from '../../../shared/sqlSplit'

type CodeEditor = monaco.editor.IStandaloneCodeEditor

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
  initialSql: string
  selectOnMount?: boolean
  onChange: (sql: string) => void
  onMount: (editor: CodeEditor) => void
  onRun: () => void
}

export function SqlEditor({ initialSql, selectOnMount, onChange, onMount, onRun }: Props): JSX.Element {
  // Monaco commands are registered once, so call through a ref to see the latest handler.
  const onRunRef = useRef(onRun)
  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])

  return (
    <Editor
      defaultLanguage={editorLanguage()}
      defaultValue={initialSql}
      theme="naskali-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        lineHeight: 22,
        padding: { top: 10, bottom: 10 },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordBasedSuggestions: 'off',
        tabSize: 2
      }}
      onChange={(value) => onChange(value ?? '')}
      onMount={(editor) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current())
        const range = selectOnMount && editor.getModel()?.getFullModelRange()
        if (range) editor.setSelection(range)
        if (!editor.getDomNode()?.closest('[hidden]')) editor.focus()
        onMount(editor)
      }}
    />
  )
}
