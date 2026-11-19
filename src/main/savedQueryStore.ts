import type { SavedQuery } from '../shared/types'
import { createConnectionListStore } from './connectionListStore'

export function createSavedQueryStore(file: () => string) {
  const { load, update } = createConnectionListStore<SavedQuery>(file)
  return {
    load,
    save: (identity: string, query: SavedQuery) => update(identity, (current = []) =>
      current.some((item) => item.id === query.id)
        ? current.map((item) => item.id === query.id ? query : item)
        : [...current, query]),
    remove: (identity: string, id: string) => update(identity, (current = []) =>
      current.filter((item) => item.id !== id))
  }
}
