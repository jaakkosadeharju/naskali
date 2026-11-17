import { useEffect, useState, type FormEvent } from 'react'
import {
  DRIVER_LABELS,
  type ConnectionConfig,
  type ConnectionInfo,
  type DriverKind,
  type ServerConnectionConfig,
  type SqliteConnectionConfig
} from '../../../shared/types'
import logo from '../assets/logo.png'

interface Props {
  onConnected: (cfg: ConnectionConfig, info: ConnectionInfo) => void
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

export function ConnectDialog({ onConnected }: Props): JSX.Element {
  // One draft per database type, so switching types doesn't lose what was typed.
  const [drafts, setDrafts] = useState<Record<DriverKind, ConnectionConfig>>({ ...DEFAULTS })
  const [driver, setDriver] = useState<DriverKind>('mysql')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.loadSavedConnection().then((r) => {
      if (r.ok && r.value) {
        const { remember: rem, ...saved } = r.value
        setDrafts((d) => ({ ...d, [saved.driver]: { ...DEFAULTS[saved.driver], ...saved } }))
        setDriver(saved.driver)
        setRemember(rem)
      }
    })
  }, [])

  const cfg = drafts[driver]
  const update = (patch: Partial<ServerConnectionConfig> | Partial<SqliteConnectionConfig>): void =>
    setDrafts((d) => ({ ...d, [driver]: { ...d[driver], ...patch } as ConnectionConfig }))

  async function browse(): Promise<void> {
    const r = await window.api.pickSqliteFile()
    if (r.ok && r.value) update({ file: r.value })
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const r = await window.api.connect(cfg, remember)
    setBusy(false)
    if (r.ok) onConnected(cfg, r.value)
    else setError(r.error)
  }

  return (
    <div className="dialog-backdrop">
      <form className="dialog connect-dialog" onSubmit={submit}>
        <div className="dialog-brand">
          <img src={logo} alt="" width={56} height={56} />
          <div>
            <h2>Naskali</h2>
            <p>Connect to a database</p>
          </div>
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

        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {cfg.driver === 'sqlite'
            ? 'Remember connection'
            : 'Remember connection (password goes to the OS keyring if one is available)'}
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Connecting…' : `Connect to ${DRIVER_LABELS[driver]}`}
        </button>
      </form>
    </div>
  )
}
