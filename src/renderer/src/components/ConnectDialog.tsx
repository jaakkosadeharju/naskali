import { useEffect, useState, type FormEvent } from 'react'
import type { ConnectionConfig } from '../../../shared/types'
import logo from '../assets/logo.png'

interface Props {
  onConnected: (cfg: ConnectionConfig, info: { serverVersion: string; database: string | null }) => void
}

const DEFAULTS: ConnectionConfig = { host: '127.0.0.1', port: 3306, user: 'dev', password: '', database: 'shop' }

export function ConnectDialog({ onConnected }: Props): JSX.Element {
  const [cfg, setCfg] = useState<ConnectionConfig>(DEFAULTS)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.loadSavedConnection().then((r) => {
      if (r.ok && r.value) {
        const { remember: rem, ...saved } = r.value
        setCfg(saved)
        setRemember(rem)
      }
    })
  }, [])

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]): void => setCfg((c) => ({ ...c, [k]: v }))

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
            <p>Connect to a MySQL server</p>
          </div>
        </div>
        <div className="row">
          <label className="grow">
            Host
            <input value={cfg.host} onChange={(e) => set('host', e.target.value)} required autoFocus />
          </label>
          <label style={{ width: 90 }}>
            Port
            <input type="number" value={cfg.port} onChange={(e) => set('port', Number(e.target.value))} required />
          </label>
        </div>
        <label>
          User
          <input value={cfg.user} onChange={(e) => set('user', e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={cfg.password} onChange={(e) => set('password', e.target.value)} />
        </label>
        <label>
          <span>
            Default database <span className="muted">(optional)</span>
          </span>
          <input value={cfg.database ?? ''} onChange={(e) => set('database', e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember connection (password goes to the OS keyring if one is available)
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
