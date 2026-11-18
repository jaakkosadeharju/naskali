export const EXPORT_COMMANDS = ['export-csv', 'export-json'] as const
export const COPY_COMMANDS = ['copy-csv', 'copy-json', 'copy-json-with-headers'] as const

export type MenuCommand =
  | typeof EXPORT_COMMANDS[number]
  | typeof COPY_COMMANDS[number]
  | 'new-query' | 'close-tab'
  | 'connect' | 'disconnect' | 'refresh-schema'
  | 'run-query' | 'cancel-query'
  | 'find-table' | 'toggle-inspector'
