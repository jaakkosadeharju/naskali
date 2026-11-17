import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionConfig } from '../shared/types'

// Remembers the last connection in userData. The password is only stored when
// the OS keyring is available (on Linux that means libsecret/kwallet); with
// Electron's "basic_text" fallback it would effectively be plaintext, so we skip it.

interface Stored {
  host: string
  port: number
  user: string
  database?: string
  password?: string // base64 of safeStorage-encrypted bytes
}

const file = (): string => join(app.getPath('userData'), 'connection.json')

function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
  return true
}

export async function saveConnection(cfg: ConnectionConfig): Promise<void> {
  const stored: Stored = { host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database }
  if (cfg.password && canEncrypt()) {
    stored.password = safeStorage.encryptString(cfg.password).toString('base64')
  }
  await fs.writeFile(file(), JSON.stringify(stored, null, 2), { mode: 0o600 })
}

export async function forgetConnection(): Promise<void> {
  await fs.rm(file(), { force: true })
}

export async function loadConnection(): Promise<(ConnectionConfig & { remember: boolean }) | null> {
  let stored: Stored
  try {
    stored = JSON.parse(await fs.readFile(file(), 'utf8'))
  } catch {
    return null
  }
  let password = ''
  if (stored.password && canEncrypt()) {
    try {
      password = safeStorage.decryptString(Buffer.from(stored.password, 'base64'))
    } catch {
      // Keyring changed; just ask for the password again.
    }
  }
  return { host: stored.host, port: stored.port, user: stored.user, database: stored.database, password, remember: true }
}
