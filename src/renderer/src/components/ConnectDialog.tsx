import { useEffect, useState, type FormEvent } from 'react'
import {
  CONNECTION_COLORS,
  DRIVER_LABELS,
  type ConnectionColor,
  type ConnectionConfig,
  type ConnectionInfo,
  type DriverKind,
  type SavedConnection,
  type ServerConnectionConfig,
  type SqliteConnectionConfig
} from '../../../shared/types'
import { removeWorkspace } from '../workspaceStore'
import logo from '../assets/logo.png'

interface Props {
  onConnected: (cfg: ConnectionConfig, info: ConnectionInfo, color: ConnectionColor, profileId: string | null) => void
}

const DRIVERS: DriverKind[] = ['mysql', 'postgres', 'mssql', 'sqlite']

/** Per-type starting values (matching the dev databases from docker-compose). */
const DEFAULTS: Record<DriverKind, ConnectionConfig> = {
  mysql: { driver: 'mysql', host: '127.0.0.1', port: 3306, user: 'dev', password: '', database: 'shop' },
  postgres: { driver: 'postgres', host: '127.0.0.1', port: 5432, user: 'dev', password: '', database: 'shop', ssl: false },
  mssql: { driver: 'mssql', host: '127.0.0.1', port: 1433, user: 'sa', password: '', database: 'shop', trustServerCertificate: true },
  sqlite: { driver: 'sqlite', file: '', readOnly: false, create: false }
}

const DATABASE_LABEL: Record<ServerConnectionConfig['driver'], { label: string; hint: string }> = {
  mysql: { label: 'Default database', hint: '(optional)' },
  postgres: { label: 'Database', hint: '(defaults to the user name)' },
  mssql: { label: 'Database', hint: "(optional; the login's default otherwise)" }
}

function sameTarget(a: ConnectionConfig, b: ConnectionConfig): boolean {
  if (a.driver !== b.driver) return false
  if (a.driver === 'sqlite' || b.driver === 'sqlite') {
    return a.driver === 'sqlite' && b.driver === 'sqlite' && a.file === b.file
  }
  return a.host === b.host && a.port === b.port && a.user === b.user && (a.database ?? '') === (b.database ?? '')
}

export function ConnectDialog({ onConnected }: Props): JSX.Element {
  // One draft per database type, so switching types doesn't lose what was typed.
  const [drafts, setDrafts] = useState<Record<DriverKind, ConnectionConfig>>({ ...DEFAULTS })
  const [driver, setDriver] = useState<DriverKind>('mysql')
  const [saved, setSaved] = useState<SavedConnection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<ConnectionColor>('blue')
  const [busy, setBusy] = useState<'loading' | 'connecting' | 'testing' | 'saving' | 'removing' | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const [testPassed, setTestPassed] = useState(false)

  function selectConnection(connection?: SavedConnection): void {
    setSelectedId(connection?.id ?? null)
    setName(connection?.name ?? '')
    setColor(connection?.color ?? 'blue')
    setDriver(connection?.config.driver ?? 'mysql')
    setDrafts(connection ? { ...DEFAULTS, [connection.config.driver]: connection.config } : { ...DEFAULTS })
    setError(null)
    setTestPassed(false)
  }

  useEffect(() => {
    let active = true
    void window.api.listConnections().then((r) => {
      if (!active) return
      setBusy(null)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setSaved(r.value)
      selectConnection(r.value[0])
    })
    return () => { active = false }
  }, [])

  const cfg = drafts[driver]
  const update = (patch: Partial<ServerConnectionConfig> | Partial<SqliteConnectionConfig>): void => {
    setDrafts((d) => ({ ...d, [driver]: { ...d[driver], ...patch } as ConnectionConfig }))
    setError(null)
    setTestPassed(false)
  }

  async function browse(): Promise<void> {
    const r = await window.api.pickSqliteFile()
    if (r.ok && r.value) update({ file: r.value })
  }

  async function connect(config: ConnectionConfig, theme: ConnectionColor, profileId: string | null): Promise<void> {
    if (busy) return
    setBusy('connecting')
    setError(null)
    setTestPassed(false)
    try {
      const r = await window.api.connect(config)
      if (r.ok) onConnected(config, r.value, theme, profileId)
      else setError(r.error)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value')
    if (action === 'test') {
      setBusy('testing')
      setError(null)
      setTestPassed(false)
      try {
        const r = await window.api.testConnection(cfg)
        if (r.ok) setTestPassed(true)
        else setError(r.error)
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(null)
      }
      return
    }
    if (action === 'save') {
      setBusy('saving')
      setError(null)
      const r = await window.api.saveConnection(selectedId, name, cfg, color)
      setBusy(null)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setSaved(r.value)
      setSelectedId(selectedId ?? r.value.at(-1)!.id)
      setName(name.trim())
      return
    }

    const profile = saved.find((connection) => connection.id === selectedId)
    await connect(cfg, color, profile && sameTarget(profile.config, cfg) ? profile.id : null)
  }

  async function remove(): Promise<void> {
    if (!selectedId || busy) return
    if (!window.confirm(`Remove the saved connection "${name}"?`)) return
    setBusy('removing')
    setError(null)
    const r = await window.api.deleteConnection(selectedId)
    setBusy(null)
    if (r.ok) {
      removeWorkspace(selectedId)
      setSaved(r.value)
      selectConnection()
    } else {
      setError(r.error)
    }
  }

  return (
    <div className="dialog-backdrop">
      <form className="dialog connect-dialog" data-connection-color={color} onSubmit={submit}>
        <div className="dialog-brand">
          <img src={logo} alt="" width={56} height={56} />
          <div>
            <h2>Naskali</h2>
            <p>Connect to a database</p>
          </div>
        </div>

        <section className="connection-sidebar" aria-labelledby="saved-connections-heading">
          <h2 id="saved-connections-heading">Saved connections</h2>
          <ul className="saved-connection-list">
            {saved.map((connection) => (
              <li key={connection.id}>
                <button
                  className="saved-connection"
                  type="button"
                  aria-current={connection.id === selectedId}
                  disabled={busy !== null}
                  title="Double-click to connect"
                  onClick={() => selectConnection(connection)}
                  onDoubleClick={() => void connect(connection.config, connection.color ?? 'blue', connection.id)}
                >
                  <span className="connection-color-swatch" data-connection-color={connection.color ?? 'blue'} aria-hidden="true" />
                  <span className="saved-connection-details">
                    <strong title={connection.name}>{connection.name}</strong>
                    <span>{DRIVER_LABELS[connection.config.driver]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {saved.length === 0 && <p className="muted">{busy === 'loading' ? 'Loading connections…' : 'No saved connections yet.'}</p>}
          <button
            className="new-connection"
            type="button"
            aria-current={selectedId === null}
            disabled={busy !== null}
            onClick={() => selectConnection()}
          >
            + New connection
          </button>
        </section>
        <fieldset className="connection-fields" disabled={busy !== null}>
          <div className="row">
            <label className="grow">
              Connection name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name for saving" />
            </label>
            <fieldset className="connection-color-picker">
              <legend>Connection color</legend>
              <div className="row">
                {CONNECTION_COLORS.map((option) => {
                  const label = option[0].toUpperCase() + option.slice(1)
                  return (
                    <input
                      key={option}
                      className="connection-color-swatch"
                      type="radio"
                      name="connection-color"
                      aria-label={label}
                      title={label}
                      data-connection-color={option}
                      checked={color === option}
                      onChange={() => setColor(option)}
                    />
                  )
                })}
              </div>
            </fieldset>
          </div>

          <div className="segmented driver-picker" role="radiogroup" aria-label="Database type">
            {DRIVERS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={driver === d}
                className={driver === d ? 'active' : ''}
                onClick={() => {
                  setDriver(d)
                  setError(null)
                  setTestPassed(false)
                }}
              >
                {DRIVER_LABELS[d]}
              </button>
            ))}
          </div>

          {cfg.driver === 'sqlite' ? (
            <>
              <label>
                Database file
                <div className="row">
                  <input
                    className="grow"
                    value={cfg.file}
                    onChange={(e) => update({ file: e.target.value })}
                    placeholder="/path/to/database.sqlite"
                    required
                    autoFocus
                  />
                  <button type="button" onClick={() => void browse()}>
                    Browse…
                  </button>
                </div>
              </label>
              <label className="check">
                <input type="checkbox" checked={!!cfg.readOnly} onChange={(e) => update({ readOnly: e.target.checked })} />
                Open read-only
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!cfg.create}
                  disabled={!!cfg.readOnly}
                  onChange={(e) => update({ create: e.target.checked })}
                />
                Create the file if it doesn&apos;t exist
              </label>
            </>
          ) : (
            <>
              <div className="row">
                <label className="grow">
                  Host
                  <input value={cfg.host} onChange={(e) => update({ host: e.target.value })} required autoFocus />
                </label>
                <label style={{ width: 90 }}>
                  Port
                  <input type="number" value={cfg.port} onChange={(e) => update({ port: Number(e.target.value) })} required />
                </label>
              </div>
              <label>
                User
                <input value={cfg.user} onChange={(e) => update({ user: e.target.value })} required />
              </label>
              <label>
                Password
                <input type="password" value={cfg.password} onChange={(e) => update({ password: e.target.value })} />
              </label>
              <label>
                <span>
                  {DATABASE_LABEL[cfg.driver].label} <span className="muted">{DATABASE_LABEL[cfg.driver].hint}</span>
                </span>
                <input value={cfg.database ?? ''} onChange={(e) => update({ database: e.target.value })} />
              </label>
              {cfg.driver === 'postgres' && (
                <label className="check">
                  <input type="checkbox" checked={!!cfg.ssl} onChange={(e) => update({ ssl: e.target.checked })} />
                  Use SSL/TLS
                </label>
              )}
              {cfg.driver === 'mssql' && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!cfg.trustServerCertificate}
                    onChange={(e) => update({ trustServerCertificate: e.target.checked })}
                  />
                  Trust the server certificate (self-signed, e.g. local/dev servers)
                </label>
              )}
            </>
          )}

          <div className="row connection-actions">
            <button type="submit" className="primary">
              {busy === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            <button type="submit" value="test">
              {busy === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
            <button type="submit" value="save" disabled={!name.trim()}>
              {busy === 'saving' ? 'Saving…' : 'Save connection'}
            </button>
            {selectedId && <button type="button" onClick={() => void remove()}>Remove</button>}
          </div>
          {testPassed && <div className="connection-test-success" role="status">Connection successful.</div>}
          {error && <div className="error" role="alert">{error}</div>}
        </fieldset>
      </form>
    </div>
  )
}
