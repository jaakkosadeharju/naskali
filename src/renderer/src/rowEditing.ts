import type { CellValue, ChangeSet, ResultEditTable } from '../../shared/types'

// Staged edits for a grid of rows read from one or more tables (a table tab, or
// a query result with joins). Pure functions over an immutable `Staged` value.
// Existing rows are addressed per table by their primary key, so an edit shows
// on every grid row of the same table row and survives paging and refreshes.

/** A table whose rows the grid can edit; `field`s are grid column indices. */
export type EditTarget = ResultEditTable

export interface PendingUpdate {
  target: number
  key: Record<string, CellValue>
  /** New values by table column name. */
  set: Record<string, CellValue>
}

export interface PendingDelete {
  target: number
  key: Record<string, CellValue>
}

/** A row to insert into the first target; only explicitly set columns. */
export interface NewRow {
  id: number
  values: Record<string, CellValue>
}

export interface Staged {
  /** By `rowId`. */
  updates: ReadonlyMap<string, PendingUpdate>
  /** By `rowId`. */
  deletes: ReadonlyMap<string, PendingDelete>
  /** Newest first. */
  inserts: readonly NewRow[]
}

export const emptyStaged: Staged = { updates: new Map(), deletes: new Map(), inserts: [] }

export const sameValue = (a: CellValue, b: CellValue): boolean => a === b || (a !== null && b !== null && String(a) === String(b))

/** The target and table column a grid field writes, if it is editable. */
function columnOf(targets: readonly EditTarget[], field: number): { target: number; column: string } | undefined {
  for (let t = 0; t < targets.length; t++) {
    const c = targets[t].columns.find((x) => x.field === field)
    if (c) return { target: t, column: c.column }
  }
  return undefined
}

/** Identifies a table row; null when part of its key is NULL (e.g. the missing side of an outer join). */
function rowId(targets: readonly EditTarget[], t: number, row: readonly CellValue[]): string | null {
  const values = targets[t].key.map((k) => row[k.field])
  return values.some((v) => v === null || v === undefined) ? null : JSON.stringify([t, ...values])
}

const keyOf = (target: EditTarget, row: readonly CellValue[]): Record<string, CellValue> =>
  Object.fromEntries(target.key.map((k) => [k.column, row[k.field]]))

const withUpdate = (staged: Staged, id: string, update: PendingUpdate | null): Staged => {
  const updates = new Map(staged.updates)
  if (update && Object.keys(update.set).length) updates.set(id, update)
  else updates.delete(id)
  return { ...staged, updates }
}

/** Whether a cell of an existing row can be edited. */
export function canEdit(targets: readonly EditTarget[], row: readonly CellValue[], field: number): boolean {
  const c = columnOf(targets, field)
  return !!c && rowId(targets, c.target, row) !== null
}

/** Stages `value` for a cell of an existing (original) row; setting the original value drops the edit. */
export function stageEdit(staged: Staged, targets: readonly EditTarget[], row: readonly CellValue[], field: number, value: CellValue): Staged {
  const c = columnOf(targets, field)
  const id = c && rowId(targets, c.target, row)
  if (!c || !id) return staged
  const entry = staged.updates.get(id) ?? { target: c.target, key: keyOf(targets[c.target], row), set: {} }
  const set = { ...entry.set }
  if (sameValue(row[field], value)) delete set[c.column]
  else set[c.column] = value
  return withUpdate(staged, id, { ...entry, set })
}

export function revertEdit(staged: Staged, targets: readonly EditTarget[], row: readonly CellValue[], field: number): Staged {
  const c = columnOf(targets, field)
  const id = c && rowId(targets, c.target, row)
  const entry = id ? staged.updates.get(id) : undefined
  if (!c || !id || !entry || !(c.column in entry.set)) return staged
  const set = { ...entry.set }
  delete set[c.column]
  return withUpdate(staged, id, { ...entry, set })
}

export function isEdited(staged: Staged, targets: readonly EditTarget[], row: readonly CellValue[], field: number): boolean {
  const c = columnOf(targets, field)
  const id = c && rowId(targets, c.target, row)
  return !!c && !!id && c.column in (staged.updates.get(id)?.set ?? {})
}

/** Marks rows of target `t` for deletion, or unmarks them when all are marked already. */
export function toggleDelete(staged: Staged, targets: readonly EditTarget[], rows: readonly (readonly CellValue[])[], t = 0): Staged {
  const marked = rows.flatMap((row) => {
    const id = rowId(targets, t, row)
    return id ? [{ id, key: keyOf(targets[t], row) }] : []
  })
  if (marked.length === 0) return staged
  const unmark = marked.every((m) => staged.deletes.has(m.id))
  const deletes = new Map(staged.deletes)
  const updates = new Map(staged.updates)
  for (const m of marked) {
    if (unmark) deletes.delete(m.id)
    else {
      deletes.set(m.id, { target: t, key: m.key })
      // A deleted row's pending edits are moot.
      updates.delete(m.id)
    }
  }
  return { ...staged, deletes, updates }
}

export function isDeleted(staged: Staged, targets: readonly EditTarget[], row: readonly CellValue[]): boolean {
  return targets.some((_, t) => {
    const id = rowId(targets, t, row)
    return !!id && staged.deletes.has(id)
  })
}

/** Existing rows with their staged edits laid over them. */
export function overlay(staged: Staged, targets: readonly EditTarget[], rows: readonly CellValue[][]): CellValue[][] {
  if (staged.updates.size === 0) return rows as CellValue[][]
  const fieldOf = targets.map((t) => new Map(t.columns.map((c) => [c.column, c.field])))
  return rows.map((row) => {
    let copy: CellValue[] | null = null
    targets.forEach((_, t) => {
      const id = rowId(targets, t, row)
      const update = id ? staged.updates.get(id) : undefined
      if (!update) return
      copy ??= row.slice()
      for (const [column, value] of Object.entries(update.set)) copy[fieldOf[t].get(column)!] = value
    })
    return copy ?? row
  })
}

export function addInsert(staged: Staged, id: number): Staged {
  return { ...staged, inserts: [{ id, values: {} }, ...staged.inserts] }
}

export function setInsertValue(staged: Staged, id: number, column: string, value: CellValue): Staged {
  return { ...staged, inserts: staged.inserts.map((r) => (r.id === id ? { ...r, values: { ...r.values, [column]: value } } : r)) }
}

/** Back to the column's DEFAULT. */
export function clearInsertValue(staged: Staged, id: number, column: string): Staged {
  return {
    ...staged,
    inserts: staged.inserts.map((r) => {
      if (r.id !== id) return r
      const values = { ...r.values }
      delete values[column]
      return { ...r, values }
    })
  }
}

export function dropInserts(staged: Staged, ids: readonly number[]): Staged {
  return { ...staged, inserts: staged.inserts.filter((r) => !ids.includes(r.id)) }
}

export function countChanges(staged: Staged): { inserted: number; updated: number; deleted: number } {
  return { inserted: staged.inserts.length, updated: staged.updates.size, deleted: staged.deletes.size }
}

/** One change set per table with staged changes; inserts go to the first target. */
export function toChangeSets(staged: Staged, targets: readonly EditTarget[]): ChangeSet[] {
  return targets.flatMap((target, t) => {
    const cs: ChangeSet = {
      schema: target.schema,
      table: target.table,
      deletes: [...staged.deletes.values()].filter((d) => d.target === t).map(({ key }) => ({ key })),
      updates: [...staged.updates.values()].filter((u) => u.target === t).map(({ key, set }) => ({ key, set })),
      inserts: t === 0 ? staged.inserts.map(({ values }) => ({ values })) : []
    }
    return cs.deletes.length || cs.updates.length || cs.inserts.length ? [cs] : []
  })
}
