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
  loadFavourites: (identity, legacy) => ipcRenderer.invoke('db:loadFavourites', identity, legacy),
  setFavourite: (identity, table, favourite) => ipcRenderer.invoke('db:setFavourite', identity, table, favourite),
  loadSavedQueries: (identity, legacy) => ipcRenderer.invoke('db:loadSavedQueries', identity, legacy),
  saveQuery: (identity, query) => ipcRenderer.invoke('db:saveQuery', identity, query),
  deleteSavedQuery: (identity, id) => ipcRenderer.invoke('db:deleteSavedQuery', identity, id),
  introspect: () => ipcRenderer.invoke('db:introspect'),
  query: (tabId, sql) => ipcRenderer.invoke('db:query', tabId, sql),
  exportRows: (format, name, columns, rows) => ipcRenderer.invoke('db:exportRows', format, name, columns, rows),
  cancel: (tabId) => ipcRenderer.invoke('db:cancel', tabId),
  closeQueryTab: (tabId) => ipcRenderer.invoke('db:closeQueryTab', tabId),
  editorTransaction: (tabId, action) => ipcRenderer.invoke('db:editorTransaction', tabId, action),
  useSchema: (name) => ipcRenderer.invoke('db:use', name),
  pickSqliteFile: () => ipcRenderer.invoke('db:pickSqliteFile'),
  explorerMenu: (target, options) => ipcRenderer.invoke('db:explorerMenu', target, options),
  previewCreateTable: (action) => ipcRenderer.invoke('db:previewCreateTable', action),
  changeTable: (action) => ipcRenderer.invoke('db:changeTable', action),
  procedureCall: (schema, name) => ipcRenderer.invoke('db:procedureCall', schema, name),
  procedureDefinition: (schema, name) => ipcRenderer.invoke('db:procedureDefinition', schema, name),
  rowLookup: (schema, table, expression) => ipcRenderer.invoke('db:rowLookup', schema, table, expression),
  tableDetails: (schema, table) => ipcRenderer.invoke('db:tableDetails', schema, table),
  tableData: (req) => ipcRenderer.invoke('db:tableData', req),
  previewChanges: (sets) => ipcRenderer.invoke('db:previewChanges', sets),
  applyChanges: (sets) => ipcRenderer.invoke('db:applyChanges', sets),
  resultEditInfo: (sql, fields) => ipcRenderer.invoke('db:resultEditInfo', sql, fields)
}

contextBridge.exposeInMainWorld('api', api)
