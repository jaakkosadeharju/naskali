import { expect, it, vi } from 'vitest'
import { QuerySessions } from '../querySessions'
import type { ConnectionInfo, QueryResult } from '../../shared/types'
import { fakeDriver } from './fakeDriver'

const result: QueryResult = { kind: 'ok', affectedRows: 0, insertId: null, info: '', elapsedMs: 0 }
const info: ConnectionInfo = {
  driver: 'mysql', serverVersion: 'test', database: 'shop', schema: 'shop', capabilities: { switchSchema: true }
}

function editor() {
  return {
    ...fakeDriver([]),
    connect: vi.fn(async () => info),
    query: vi.fn(async (_sql: string) => result),
    cancel: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    currentSchema: vi.fn(async () => info.schema),
    useSchema: vi.fn(async (_name: string) => {})
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

it('runs separate tabs concurrently and cancels only the requested tab', async () => {
  const left = editor()
  const right = editor()
  const sessions = new QuerySessions(vi.fn().mockReturnValueOnce(left).mockReturnValueOnce(right))
  const started = deferred<void>()
  const pending = deferred<QueryResult>()
  left.query.mockImplementationOnce(() => {
    started.resolve()
    return pending.promise
  })
  left.cancel.mockImplementationOnce(async () => pending.reject(new Error('Query cancelled')))

  const slow = sessions.query('left', 'SELECT slow')
  const cancelled = expect(slow).rejects.toThrow('Query cancelled')
  await started.promise
  await expect(sessions.query('left', 'SELECT duplicate')).rejects.toThrow('already running')
  await expect(sessions.query('right', 'SELECT fast')).resolves.toMatchObject({ result })
  await sessions.cancel('left')
  await cancelled
  expect(right.cancel).not.toHaveBeenCalled()
  await expect(sessions.query('left', 'SELECT retry')).resolves.toMatchObject({ result })
  expect(left.connect).toHaveBeenCalledTimes(1)

  await sessions.close('left')
  expect(left.disconnect).toHaveBeenCalledTimes(1)
  expect(right.disconnect).not.toHaveBeenCalled()
  await sessions.disconnect()
  expect(right.disconnect).toHaveBeenCalledTimes(1)
})

it('cancels a query while its tab is still connecting', async () => {
  const driver = editor()
  const connecting = deferred<ConnectionInfo>()
  driver.connect.mockReturnValueOnce(connecting.promise)
  const sessions = new QuerySessions(() => driver)
  const query = sessions.query('tab', 'SELECT 1')
  await sessions.cancel('tab')
  connecting.resolve(info)
  await expect(query).rejects.toThrow('Query cancelled')
  expect(driver.query).not.toHaveBeenCalled()
})

it('applies a database selection once on both existing and new sessions', async () => {
  const left = editor()
  const right = editor()
  const sessions = new QuerySessions(vi.fn().mockReturnValueOnce(left).mockReturnValueOnce(right))
  await sessions.query('left', 'SELECT 1')
  sessions.useSchema('other')
  await sessions.query('left', 'SELECT 1')
  await sessions.query('right', 'SELECT 1')
  await sessions.query('left', 'SELECT 1')
  expect(left.useSchema.mock.calls).toEqual([['other']])
  expect(right.useSchema.mock.calls).toEqual([['other']])
})

it('counts successful statements in a tab and requires rollback after a failed transaction', async () => {
  const driver = editor()
  let status: 'idle' | 'active' | 'failed' = 'idle'
  driver.editorTransactionStatus = async () => status
  driver.beginEditorTransaction = async () => { status = 'active' }
  const finish = vi.fn(async () => { status = 'idle' })
  driver.endEditorTransaction = finish
  const sessions = new QuerySessions(() => driver)

  expect(await sessions.transaction('tab', 'begin')).toEqual({ statements: 0, rollbackOnly: false })
  await sessions.query('tab', 'SELECT 1')
  await expect(sessions.query('tab', '-- comment\nCOMMIT')).rejects.toThrow('Use the transaction controls')
  await expect(sessions.query('tab', 'DROP TABLE orders')).rejects.toThrow('commit implicitly')
  driver.query.mockImplementationOnce(async () => {
    status = 'failed'
    throw new Error('Statement failed')
  })
  await expect(sessions.query('tab', 'SELECT invalid')).rejects.toThrow('Statement failed')
  expect(await sessions.transaction('tab', 'status')).toEqual({ statements: 1, rollbackOnly: true })
  expect(await sessions.transaction('other-tab', 'status')).toBeNull()
  await expect(sessions.transaction('tab', 'commit')).rejects.toThrow('must be rolled back')
  expect(await sessions.transaction('tab', 'rollback')).toBeNull()
  expect(finish).toHaveBeenCalledExactlyOnceWith('rollback')
})
