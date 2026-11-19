export const EXPORT_COMMANDS = ['export-csv', 'export-json'] as const
export const COPY_COMMANDS = ['copy-csv', 'copy-json', 'copy-json-with-headers'] as const

export type MenuCommand =
  | typeof EXPORT_COMMANDS[number]
  | typeof COPY_COMMANDS[number]
  | 'new-query' | 'save-query' | 'close-tab'
  | 'connect' | 'disconnect' | 'refresh-schema'
  | 'run-query' | 'cancel-query'
  | 'toggle-line-comment' | 'toggle-block-comment'
  | 'find-table' | 'toggle-inspector'
  | 'refresh-table-data'
