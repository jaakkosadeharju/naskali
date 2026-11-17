import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  CONNECTION_COLORS,
  type ConnectionColor,
  type ConnectionConfig,
  type SavedConnection,
  type ServerConnectionConfig,
  type SqliteConnectionConfig
} from '../shared/types'

type StoredServerConfig = Omit<ServerConnectionConfig, 'password'> & { password?: string }
type StoredConfig = SqliteConnectionConfig | StoredServerConfig
type LegacyConfig = StoredConfig | Omit<StoredServerConfig, 'driver'>
type StoredConnection = Omit<SavedConnection, 'config'> & { config: StoredConfig }

const file = (name: string): string => join(app.getPath('userData'), name)

async function canEncrypt(): Promise<boolean> {
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
  return safeStorage.isAsyncEncryptionAvailable()
}

async function readFile<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file(name), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readConnections(): Promise<StoredConnection[]> {
  const saved = await readFile<StoredConnection[] | LegacyConfig>('connection.json')
  if (!saved) return []
  if (Array.isArray(saved)) return saved

  // Saved connections from before multi-database support were MySQL.
  const config: StoredConfig = 'driver' in saved ? saved : { ...saved, driver: 'mysql' }
  return [{ id: 'legacy', name: 'Last connection', config }]
}

let pendingWrite: Promise<unknown> = Promise.resolve()

function changeConnections(
  update: (saved: StoredConnection[]) => StoredConnection[] | Promise<StoredConnection[]>
): Promise<SavedConnection[]> {
  const write = pendingWrite.then(async () => {
    const saved = await update(await readConnections())
    const temp = file(`connection-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temp, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' })
      await fs.rename(temp, file('connection.json'))
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
    return Promise.all(saved.map(decodeConnection))
  })
  pendingWrite = write.catch(() => {})
  return write
}

export async function listConnections(): Promise<SavedConnection[]> {
  await pendingWrite
  return Promise.all((await readConnections()).map(decodeConnection))
}

export function saveConnection(
  id: string | null,
  name: string,
  config: ConnectionConfig,
  color: ConnectionColor
): Promise<SavedConnection[]> {
  return changeConnections(async (saved) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Enter a connection name.')
    if (!CONNECTION_COLORS.includes(color)) throw new Error('Choose a valid connection color.')
    if (id !== null && !saved.some((connection) => connection.id === id)) {
      throw new Error('This saved connection no longer exists.')
    }

    let stored: StoredConfig = config
    if (config.driver !== 'sqlite') {
      const { password, ...settings } = config
      stored = settings
      if (password && await canEncrypt()) {
        const encrypted = await safeStorage.encryptStringAsync(password)
        // Linux can fall back to Chromium's fixed-key v10 encryption without a keyring.
        if (process.platform !== 'linux' || encrypted.toString('ascii', 0, 3) !== 'v10') {
          stored.password = encrypted.toString('base64')
        }
      }
    }

    const entry = { id: id ?? randomUUID(), name: trimmed, color, config: stored }
    return id === null
      ? [...saved, entry]
      : saved.map((connection) => connection.id === id ? entry : connection)
  })
}

export function deleteConnection(id: string): Promise<SavedConnection[]> {
  return changeConnections((saved) => saved.filter((connection) => connection.id !== id))
}

async function decodeConnection({ config, color = 'blue', ...stored }: StoredConnection): Promise<SavedConnection> {
  const entry = { ...stored, color: CONNECTION_COLORS.includes(color) ? color : 'blue' as const }
  if (config.driver === 'sqlite') return { ...entry, config }

  let password = ''
  if (config.password) {
    try {
      if (await canEncrypt()) {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(config.password, 'base64'))
        password = decrypted.result
      }
    } catch {
      // The keyring may have changed. The user can enter the password again.
    }
  }
  return { ...entry, config: { ...config, password } }
}
