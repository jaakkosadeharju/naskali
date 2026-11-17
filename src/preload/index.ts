import { contextBridge, ipcRenderer } from 'electron'
import type { SqlApi } from '../shared/types'

// The only bridge between the sandboxed renderer and Node: a small, typed API.
const api: SqlApi = {
  connect: (config, remember) => ipcRenderer.invoke('db:connect', config, remember),
  disconnect: () => ipcRenderer.invoke('db:disconnect'),
  loadSavedConnection: () => ipcRenderer.invoke('db:loadSaved'),
  introspect: () => ipcRenderer.invoke('db:introspect'),
  query: (sql) => ipcRenderer.invoke('db:query', sql),
  cancel: () => ipcRenderer.invoke('db:cancel'),
  useSchema: (name) => ipcRenderer.invoke('db:use', name),
  pickSqliteFile: () => ipcRenderer.invoke('db:pickSqliteFile'),
  tableDetails: (schema, table) => ipcRenderer.invoke('db:tableDetails', schema, table),
  tableData: (req) => ipcRenderer.invoke('db:tableData', req),
  previewChanges: (cs) => ipcRenderer.invoke('db:previewChanges', cs),
  applyChanges: (cs) => ipcRenderer.invoke('db:applyChanges', cs)
}

contextBridge.exposeInMainWorld('api', api)
