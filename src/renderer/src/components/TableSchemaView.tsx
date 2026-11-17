import { useEffect, useState } from 'react'
import { monaco, SQL_LANG } from '../monacoSetup'
import type { TableDetails } from '../../../shared/types'

interface Props {
  details: TableDetails
  onOpenSql: (sql: string) => void
}

export function TableSchemaView({ details: d, onOpenSql }: Props): JSX.Element {
  const [ddlHtml, setDdlHtml] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    // colorize() escapes the text itself, so its HTML output is safe to inject.
    void monaco.editor.colorize(d.ddl, SQL_LANG, { tabSize: 2 }).then((html) => live && setDdlHtml(html))
    return () => {
      live = false
    }
  }, [d.ddl])

  return (
    <div className="schema-view">
      <p className="muted">
        {d.type === 'VIEW' ? 'View' : 'Table'}
        {d.engine && ` · ${d.engine}`}
        {d.rowsEstimate !== null && ` · ~${d.rowsEstimate.toLocaleString()} rows (estimate)`}
        {d.comment && ` · ${d.comment}`}
      </p>

      <h3>Columns</h3>
      <table className="info-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Type</th>
            <th>Null</th>
            <th>Key</th>
            <th>Default</th>
            <th>Extra</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {d.columns.map((c, i) => (
            <tr key={c.name}>
              <td className="muted">{i + 1}</td>
              <td className="mono strong">{c.name}</td>
              <td className="mono">{c.type}</td>
              <td>{c.nullable ? 'YES' : 'NO'}</td>
              <td>{c.key === 'PRI' ? '🔑 PRI' : c.key}</td>
              <td className="mono">{c.default === null ? <span className="muted">NULL</span> : c.default}</td>
              <td className="mono">{c.extra}</td>
              <td>{c.comment}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {d.indexes.length > 0 && (
        <>
          <h3>Indexes</h3>
          <table className="info-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {d.indexes.map((x) => (
                <tr key={x.name}>
                  <td className="mono strong">{x.name}</td>
                  <td className="mono">{x.columns.join(', ')}</td>
                  <td>{x.unique ? 'YES' : 'NO'}</td>
                  <td>{x.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {d.foreignKeys.length > 0 && (
        <>
          <h3>Foreign keys</h3>
          <table className="info-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>References</th>
              </tr>
            </thead>
            <tbody>
              {d.foreignKeys.map((fk) => (
                <tr key={fk.name}>
                  <td className="mono strong">{fk.name}</td>
                  <td className="mono">{fk.columns.join(', ')}</td>
                  <td className="mono">
                    {fk.refSchema === d.schema ? fk.refTable : `${fk.refSchema}.${fk.refTable}`}({fk.refColumns.join(', ')})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>
        DDL{' '}
        <button className="small" onClick={() => onOpenSql(d.ddl)}>
          Open in editor
        </button>
      </h3>
      {ddlHtml === null ? <pre className="ddl">{d.ddl}</pre> : <pre className="ddl" dangerouslySetInnerHTML={{ __html: ddlHtml }} />}
    </div>
  )
}
