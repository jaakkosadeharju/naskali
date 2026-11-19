import { createConnectionListStore } from './connectionListStore'

export function createFavouritesStore(file: () => string) {
  const { load, update } = createConnectionListStore<string>(file)
  return {
    load,
    set: (identity: string, table: string, favourite: boolean) => update(identity, (current) => {
      const favourites = new Set(current)
      if (favourite) favourites.add(table)
      else favourites.delete(table)
      return [...favourites]
    })
  }
}
