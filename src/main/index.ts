import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { MySqlSession } from './mysql'
import { forgetConnection, loadConnection, saveConnection } from './connectionStore'
import type { ChangeSet, ConnectionConfig, IpcResult, TableDataRequest } from '../shared/types'
// `?asset` makes electron-vite copy the file into the build and give us its runtime path.
import icon from '../../resources/icon.png?asset'

const session = new MySqlSession()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1e1e1e',
    title: 'Naskali',
    autoHideMenuBar: true,
    // Window/taskbar icon on Linux and Windows (macOS takes it from the app bundle).
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Never navigate the app window away; open external links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Wraps a handler so errors cross IPC as data (Electron mangles thrown error messages). */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await fn(...(args as A)) }
    } catch (err) {
      const e = err as { message?: string; code?: string }
      const message = e.message ?? String(err)
      return { ok: false, error: e.code && !message.includes(e.code) ? `${e.code}: ${message}` : message }
    }
  })
}

handle('db:connect', async (cfg: ConnectionConfig, remember: boolean) => {
  const info = await session.connect(cfg)
  if (remember) await saveConnection(cfg)
  else await forgetConnection()
  return info
})
handle('db:disconnect', () => session.disconnect())
handle('db:loadSaved', () => loadConnection())
handle('db:introspect', () => session.introspect())
handle('db:query', async (sql: string) => {
  const result = await session.query(sql)
  return { result, database: await session.currentDatabase() }
})
handle('db:cancel', () => session.cancel())
handle('db:use', (name: string) => session.useDatabase(name))
handle('db:tableDetails', (schema: string, table: string) => session.tableDetails(schema, table))
handle('db:tableData', (req: TableDataRequest) => session.tableData(req))
handle('db:previewChanges', (cs: ChangeSet) => session.previewChanges(cs))
handle('db:applyChanges', (cs: ChangeSet) => session.applyChanges(cs))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void session.disconnect()
  if (process.platform !== 'darwin') app.quit()
})
