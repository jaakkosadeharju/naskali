import { contextBridge, ipcRenderer } from 'electron'
import type { MenuCommand } from '../shared/menuCommands'
import type { SqlApi } from '../shared/types'

// The only bridge between the sandboxed renderer and Node: a small, typed API.
const api: SqlApi = {
  onMenuCommand: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, command: MenuCommand): void => listener(command)
    ipcRenderer.on('menu:command', receive)
    return () => { ipcRenderer.removeListener('menu:command', receive) }
  },
  setMenuAvailability: (commands) => ipcRenderer.send('menu:availability', commands),
  connect: (config) => ipcRenderer.invoke('db:connect', config),
  testConnection: (config) => ipcRenderer.invoke('db:testConnection', config),
  disconnect: () => ipcRenderer.invoke('db:disconnect'),
  listConnections: () => ipcRenderer.invoke('db:listConnections'),
  saveConnection: (id, name, config, color) => ipcRenderer.invoke('db:saveConnection', id, name, config, color),
  deleteConnection: (id) => ipcRenderer.invoke('db:deleteConnection', id),
  introspect: () => ipcRenderer.invoke('db:introspect'),
  query: (sql) => ipcRenderer.invoke('db:query', sql),
  exportRows: (format, name, columns, rows) => ipcRenderer.invoke('db:exportRows', format, name, columns, rows),
  cancel: () => ipcRenderer.invoke('db:cancel'),
  useSchema: (name) => ipcRenderer.invoke('db:use', name),
  pickSqliteFile: () => ipcRenderer.invoke('db:pickSqliteFile'),
  tableDetails: (schema, table) => ipcRenderer.invoke('db:tableDetails', schema, table),
  tableData: (req) => ipcRenderer.invoke('db:tableData', req),
  previewChanges: (cs) => ipcRenderer.invoke('db:previewChanges', cs),
  applyChanges: (cs) => ipcRenderer.invoke('db:applyChanges', cs)
}

contextBridge.exposeInMainWorld('api', api)
