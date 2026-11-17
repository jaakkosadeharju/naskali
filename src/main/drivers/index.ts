import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { ConnectionConfig } from '../../shared/types'
import { MssqlDriver } from './mssql'
import { MySqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SqliteDriver, processEndpoint, threadEndpoint, type SqliteSpawners } from './sqlite'
import type { Driver } from './types'
// electron-vite builds the worker as its own file and gives us its path.
import sqliteWorkerPath from './sqliteWorker?modulePath'

/**
 * Workers can't be started from a file inside the packaged app's asar archive,
 * but fs can read it there – so start the worker from its source text, either
 * as a thread or as a child process of Electron's own binary in Node mode.
 */
const workerSource = (): string => readFileSync(sqliteWorkerPath, 'utf8')
const sqliteSpawners: SqliteSpawners = {
  thread: () => threadEndpoint(new Worker(workerSource(), { eval: true })),
  process: () =>
    processEndpoint(
      spawn(process.execPath, ['-e', workerSource()], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'advanced'
      })
    )
}

export function createDriver(cfg: ConnectionConfig): Driver {
  switch (cfg.driver) {
    case 'mysql':
      return new MySqlDriver(cfg)
    case 'mssql':
      return new MssqlDriver(cfg)
    case 'postgres':
      return new PostgresDriver(cfg)
    case 'sqlite':
      return new SqliteDriver(cfg, sqliteSpawners)
    default:
      throw new Error(`Unsupported database type: ${(cfg as { driver: string }).driver}`)
  }
}
