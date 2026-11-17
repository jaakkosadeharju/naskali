import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDriver } from './drivers'
import { exportRows } from '../shared/exportRows'
import type { Driver } from './drivers/types'
import { applyChanges, previewChanges, tableData } from './session'
import { deleteConnection, listConnections, saveConnection } from './connectionStore'
import type { CellValue, ChangeSet, ConnectionConfig, ExportFormat, IpcResult, TableDataRequest } from '../shared/types'
// `?asset` makes electron-vite copy the file into the build and give us its runtime path.
import icon from '../../resources/icon.png?asset'
// splash.html loads splash.png from the same folder (resources/ is packaged as-is).
import splashHtml from '../../resources/splash.html?asset'

/** The connected database, if any. */
let driver: Driver | null = null
const requireDriver = (): Driver => {
  if (!driver) throw new Error('Not connected')
  return driver
}

/** Keep the splash up at least this long so it doesn't just flash by. */
const MIN_SPLASH_MS = 1200
/** Show the main window anyway if it hasn't signalled ready by then. */
const MAX_SPLASH_MS = 15_000

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 340,
    height: 380,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    show: false,
    title: 'Naskali',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  splash.webContents.on('will-navigate', (e) => e.preventDefault())
  splash.once('ready-to-show', () => splash.show())
  void splash.loadFile(splashHtml)
  return splash
}

function createWindow({ withSplash }: { withSplash: boolean }): void {
  const splash = withSplash ? createSplash() : null
  const started = Date.now()

  const win = new BrowserWindow({
    show: !splash, // with a splash: stay hidden until the UI has painted
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

  if (splash) {
    let done = false
    const reveal = (): void => {
      if (done) return
      done = true
      if (!win.isDestroyed()) win.show()
      if (!splash.isDestroyed()) splash.destroy()
    }
    win.once('ready-to-show', () => setTimeout(reveal, Math.max(0, MIN_SPLASH_MS - (Date.now() - started))))
    setTimeout(reveal, MAX_SPLASH_MS)
    // Closing the (hidden) main window early must not leave the splash behind.
    win.once('closed', () => {
      if (!splash.isDestroyed()) splash.destroy()
    })
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

handle('db:connect', async (cfg: ConnectionConfig) => {
  await driver?.disconnect()
  driver = null
  const next = createDriver(cfg)
  const info = await next.connect()
  driver = next
  return info
})
handle('db:testConnection', async (cfg: ConnectionConfig) => {
  // A SQLite test only opens an existing file and cannot create or change it.
  const probe = createDriver(cfg.driver === 'sqlite' ? { ...cfg, readOnly: true, create: false } : cfg)
  try {
    await probe.connect()
  } catch (error) {
    await probe.disconnect().catch(() => {})
    throw error
  }
  await probe.disconnect()
})
handle('db:disconnect', async () => {
  await driver?.disconnect()
  driver = null
})
handle('db:listConnections', listConnections)
handle('db:saveConnection', saveConnection)
handle('db:deleteConnection', deleteConnection)
handle('db:introspect', () => requireDriver().introspect())
handle('db:query', async (sql: string) => {
  const d = requireDriver()
  const result = await d.query(sql)
  return { result, schema: await d.currentSchema() }
})
handle('db:exportRows', async (format: ExportFormat, name: string, columns: string[], rows: CellValue[][]) => {
  if (format !== 'csv' && format !== 'json') throw new Error('Unsupported export format')
  const filename = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'results'
  const options: Electron.SaveDialogOptions = {
    title: 'Export rows',
    defaultPath: `${filename}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  }
  const win = BrowserWindow.getFocusedWindow()
  const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (canceled || !filePath) return
  await writeFile(filePath, exportRows(format, columns, rows), 'utf8')
})
handle('db:cancel', () => requireDriver().cancel())
handle('db:use', (name: string) => requireDriver().useSchema(name))
handle('db:pickSqliteFile', async () => {
  const win = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: 'Open SQLite database',
    properties: ['openFile', 'promptToCreate'],
    filters: [
      { name: 'SQLite databases', extensions: ['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return r.canceled ? null : (r.filePaths[0] ?? null)
})
handle('db:tableDetails', (schema: string, table: string) => requireDriver().tableDetails(schema, table))
handle('db:tableData', (req: TableDataRequest) => tableData(requireDriver(), req))
handle('db:previewChanges', (cs: ChangeSet) => previewChanges(requireDriver(), cs))
handle('db:applyChanges', (cs: ChangeSet) => applyChanges(requireDriver(), cs))

app.whenReady().then(() => {
  createWindow({ withSplash: true })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ withSplash: false })
  })
})

app.on('window-all-closed', () => {
  void driver?.disconnect()
  if (process.platform !== 'darwin') app.quit()
})
