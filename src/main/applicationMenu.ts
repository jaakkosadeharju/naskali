import { Menu, dialog, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/menuCommands'

export function installApplicationMenu(window: BrowserWindow): void {
  const mac = process.platform === 'darwin'
  const command = (id: MenuCommand, label: string, accelerator?: string, registerAccelerator = true): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    registerAccelerator,
    enabled: false,
    click: () => {
      if (!window.isDestroyed()) window.webContents.send('menu:command', id)
    }
  })
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as const] : []),
    {
      label: 'File',
      submenu: [
        command('new-query', 'New Query Tab', 'CommandOrControl+T'),
        command('close-tab', 'Close Tab', 'CommandOrControl+W'),
        { type: 'separator' },
        command('export-csv', 'Export as CSV…'),
        command('export-json', 'Export as JSON…'),
        ...(mac ? [] : [{ type: 'separator' } as const, { role: 'quit' } as const])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        command('copy-csv', 'Copy as CSV'),
        command('copy-json', 'Copy as JSON'),
        command('copy-json-with-headers', 'Copy as JSON with Headers')
      ]
    },
    {
      label: 'Connection',
      submenu: [
        command('connect', 'Connect…'),
        command('disconnect', 'Disconnect'),
        { type: 'separator' },
        command('refresh-schema', 'Refresh Schema')
      ]
    },
    {
      label: 'Query',
      submenu: [
        command('run-query', 'Run Selection or Statement', 'CommandOrControl+Enter', false),
        command('cancel-query', 'Cancel Running Query')
      ]
    },
    {
      label: 'View',
      submenu: [
        command('find-table', 'Find Table…', 'CommandOrControl+P', false),
        command('toggle-inspector', 'Toggle Value Inspector'),
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            if (window.isDestroyed()) return
            const mod = mac ? '⌘' : 'Ctrl+'
            void dialog.showMessageBox(window, {
              title: 'Keyboard Shortcuts',
              message: 'Keyboard Shortcuts',
              detail: [
                `${mod}T    New query tab`,
                `${mod}W    Close tab`,
                `${mod}Enter    Run selection or statement`,
                `${mod}P    Find table`,
                `${mod}I    Toggle Value Inspector outside the SQL editor`,
                'Alt+Shift+Left or Right    Move focused tab',
                'Shift+F10    Open the selected cell’s copy menu'
              ].join('\n')
            })
          }
        },
        {
          label: 'Report an Issue…',
          click: () => { void shell.openExternal('https://github.com/jaakkosadeharju/naskali/issues/new') }
        },
        { type: 'separator' },
        { role: 'about', label: 'About Naskali' }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  const commands = menu.items.flatMap((item) => item.submenu?.items.filter((entry) => entry.id) ?? [])
  window.webContents.ipc.on('menu:availability', (event, enabled: MenuCommand[]) => {
    if (event.senderFrame !== window.webContents.mainFrame || !Array.isArray(enabled)) return
    const available = new Set(enabled)
    for (const item of commands) item.enabled = available.has(item.id as MenuCommand)
  })
  window.on('closed', () => {
    for (const item of commands) item.enabled = false
  })
}
