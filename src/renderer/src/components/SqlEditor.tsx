import Editor from '@monaco-editor/react'
import { useEffect, useRef } from 'react'
import { editorDriver, editorLanguage, monaco } from '../monacoSetup'
import { SPLIT_RULES, splitStatements, statementAt, statementAtOffset, type Statement } from '../../../shared/sqlSplit'

type CodeEditor = monaco.editor.IStandaloneCodeEditor

function statementRange(model: monaco.editor.ITextModel, statement: Statement): monaco.Range {
  const start = model.getPositionAt(statement.start)
  const end = model.getPositionAt(statement.end)
  return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
}

/** Resolves and flashes the SQL to run. The gutter button always uses the cursor. */
export function sqlToRun(editor: CodeEditor, statementOnly = false): string | null {
  const model = editor.getModel()
  const sel = editor.getSelection()
  if (!model || !sel) return null
  let range: monaco.IRange
  if (!statementOnly && !sel.isEmpty()) {
    range = sel
  } else {
    const stmt = statementAt(model.getValue(), model.getOffsetAt(sel.getPosition()), SPLIT_RULES[editorDriver()])
    if (!stmt) return null
    range = statementRange(model, stmt)
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
  onRun: (statementOnly?: boolean) => void
  runDisabled: boolean
}

export function SqlEditor({ initialSql, selectOnMount, onChange, onMount, onRun, runDisabled }: Props): JSX.Element {
  // Monaco commands are registered once, so call through a ref to see the latest handler.
  const onRunRef = useRef(onRun)
  const runButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])
  useEffect(() => {
    if (runButton.current) runButton.current.disabled = runDisabled
  }, [runDisabled])

  return (
    <Editor
      defaultLanguage={editorLanguage()}
      defaultValue={initialSql}
      theme="naskali-dark"
      options={{
        minimap: { enabled: false },
        glyphMargin: true,
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

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'sql-run-statement'
        button.title = 'Run statement under cursor'
        button.setAttribute('aria-label', button.title)
        button.disabled = runDisabled
        runButton.current = button
        button.onmousedown = (event) => {
          event.preventDefault()
          event.stopPropagation()
        }
        button.onclick = (event) => {
          event.stopPropagation()
          editor.focus()
          onRunRef.current(true)
        }
        let statementLine = 1
        const widget: monaco.editor.IGlyphMarginWidget = {
          getId: () => 'run-statement',
          getDomNode: () => button,
          getPosition: () => ({
            lane: monaco.editor.GlyphMarginLane.Center,
            zIndex: 0,
            range: new monaco.Range(statementLine, 1, statementLine, 1)
          })
        }
        const highlight = editor.createDecorationsCollection()
        let statements: Statement[] = []
        let highlighted: Statement | null = null
        const updateHighlight = (): void => {
          const model = editor.getModel()
          const cursor = editor.getPosition()
          const statement = model && cursor ? statementAtOffset(statements, model.getOffsetAt(cursor)) : null
          button.style.visibility = statement ? '' : 'hidden'
          if (statement === highlighted) return
          highlighted = statement
          if (statement && model) {
            const range = statementRange(model, statement)
            if (statementLine !== range.startLineNumber) {
              statementLine = range.startLineNumber
              editor.layoutGlyphMarginWidget(widget)
            }
            highlight.set([{ range, options: { className: 'sql-active-statement' } }])
          } else {
            highlight.clear()
          }
        }
        const updateStatements = (): void => {
          statements = splitStatements(editor.getValue(), SPLIT_RULES[editorDriver()])
          updateHighlight()
        }
        editor.addGlyphMarginWidget(widget)
        editor.onDidChangeCursorPosition(updateHighlight)
        editor.onDidChangeModelContent(updateStatements)
        updateStatements()

        if (!editor.getDomNode()?.closest('[hidden]')) editor.focus()
        onMount(editor)
      }}
    />
  )
}
