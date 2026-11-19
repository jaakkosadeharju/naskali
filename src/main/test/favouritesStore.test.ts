import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createFavouritesStore } from '../favouritesStore'

it('restores favourites from disk after a fresh start and keeps connections separate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'naskali-favourites-'))
  try {
    const file = () => join(dir, 'favourites.json')
    const store = createFavouritesStore(file)
    await Promise.all([
      store.set('saved-profile', '["shop","orders"]', true),
      store.set('direct-connection', '["main","products"]', true),
      store.set('saved-profile', '["shop","customers"]', true)
    ])

    const restarted = createFavouritesStore(file)
    expect(await restarted.load('saved-profile', [])).toEqual(['["shop","orders"]', '["shop","customers"]'])
    expect(await restarted.load('direct-connection', [])).toEqual(['["main","products"]'])

    expect(await restarted.load('older-profile', ['legacy-table'])).toEqual(['legacy-table'])
    await restarted.set('older-profile', 'legacy-table', false)
    expect(await createFavouritesStore(file).load('older-profile', ['legacy-table'])).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
