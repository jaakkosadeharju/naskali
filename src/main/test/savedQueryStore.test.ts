import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSavedQueryStore } from '../savedQueryStore'

it('restores queries by connection and preserves edits and deletions after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naskali-queries-'))
  try {
    const file = () => join(directory, 'saved-queries.json')
    const store = createSavedQueryStore(file)
    const legacy = { id: 'one', name: 'Legacy query', sql: 'SELECT 1' }
    const edited = { ...legacy, name: 'Updated query', sql: 'SELECT 2' }
    const direct = { id: 'two', name: 'Direct query', sql: 'SELECT 3' }
    await store.load('profile', [legacy])
    await Promise.all([store.save('profile', edited), store.save('direct', direct)])

    const restarted = createSavedQueryStore(file)
    expect(await restarted.load('profile', [legacy])).toEqual([edited])
    expect(await restarted.load('direct', [])).toEqual([direct])
    await restarted.remove('profile', edited.id)
    expect(await createSavedQueryStore(file).load('profile', [legacy])).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
