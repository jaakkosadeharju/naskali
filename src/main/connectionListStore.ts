import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

export function createConnectionListStore<T>(file: () => string) {
  let pending: Promise<unknown> = Promise.resolve()

  async function read(): Promise<Record<string, T[]>> {
    try {
      return JSON.parse(await readFile(file(), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  function update(identity: string, change: (current: T[] | undefined) => T[]): Promise<T[]> {
    const operation = pending.then(async () => {
      const stored = await read()
      const current = Object.hasOwn(stored, identity) ? stored[identity] : undefined
      const entries = change(current)
      if (entries === current) return entries
      const path = file()
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ ...stored, [identity]: entries }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      return entries
    })
    pending = operation.catch(() => {})
    return operation
  }

  return { update, load: (identity: string, legacy: T[]) => update(identity, (current) => current ?? legacy) }
}
