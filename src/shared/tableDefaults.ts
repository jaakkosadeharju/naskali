import type { DriverKind } from './types'

export function addedColumnDefaultError(driver: DriverKind, value = ''): string | undefined {
  if (driver === 'sqlite' && value.trim().toUpperCase() === 'CURRENT_TIMESTAMP') {
    return 'SQLite requires a constant default when adding a column to an existing table. Use a literal value or leave it blank.'
  }
}
