import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionConfig } from '../shared/types'

// Remembers the last connection in userData. A password is only stored when
// the OS keyring is available (on Linux that means libsecret/kwallet); with
// Electron's "basic_text" fallback it would effectively be plaintext, so we skip it.

/** The config as saved: everything except the password, which is stored encrypted separately. */
type Stored = Omit<ConnectionConfig, 'password'> & { password?: string /* base64 of safeStorage-encrypted bytes */ }

const file = (): string => join(app.getPath('userData'), 'connection.json')

function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
  return true
}

export async function saveConnection(cfg: ConnectionConfig): Promise<void> {
  const stored: Record<string, unknown> = { ...cfg }
  delete stored.password
  if (cfg.driver !== 'sqlite' && cfg.password && canEncrypt()) {
    stored.password = safeStorage.encryptString(cfg.password).toString('base64')
  }
  await fs.writeFile(file(), JSON.stringify(stored, null, 2), { mode: 0o600 })
}

export async function forgetConnection(): Promise<void> {
  await fs.rm(file(), { force: true })
}

export async function loadConnection(): Promise<(ConnectionConfig & { remember: boolean }) | null> {
  let stored: Stored & { driver?: ConnectionConfig['driver'] }
  try {
    stored = JSON.parse(await fs.readFile(file(), 'utf8'))
  } catch {
    return null
  }
  // Files saved before multi-database support have no driver: they were MySQL.
  const driver = stored.driver ?? 'mysql'
  if (driver === 'sqlite') {
    const s = stored as Stored & { file?: string; readOnly?: boolean; create?: boolean }
    return { driver, file: s.file ?? '', readOnly: s.readOnly, create: s.create, remember: true }
  }
  const s = stored as Record<string, unknown>
  let password = ''
  if (typeof s.password === 'string' && canEncrypt()) {
    try {
      password = safeStorage.decryptString(Buffer.from(s.password, 'base64'))
    } catch {
      // Keyring changed; just ask for the password again.
    }
  }
  return {
    driver,
    host: String(s.host ?? ''),
    port: Number(s.port ?? 0),
    user: String(s.user ?? ''),
    password,
    database: typeof s.database === 'string' ? s.database : undefined,
    ssl: s.ssl === true,
    trustServerCertificate: s.trustServerCertificate === true,
    remember: true
  }
}
