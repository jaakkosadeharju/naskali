/// <reference types="vite/client" />
import type { SqlApi } from '../../shared/types'

declare global {
  interface Window {
    api: SqlApi
  }
}
