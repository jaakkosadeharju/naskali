// JSON detection for the value inspector.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/**
 * Parses a cell value as JSON when it plausibly is JSON: always for JSON
 * columns, otherwise only text that looks like an object or array (so plain
 * strings and numbers in text columns aren't "parsed").
 */
export function parseJsonValue(value: unknown, isJsonColumn: boolean): { ok: true; json: Json } | { ok: false } {
  if (typeof value !== 'string') return { ok: false }
  const t = value.trim()
  if (!isJsonColumn && !looksLikeContainer(t)) return { ok: false }
  try {
    return { ok: true, json: JSON.parse(t) as Json }
  } catch {
    return { ok: false }
  }
}

function looksLikeContainer(t: string): boolean {
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

/** A string inside JSON that itself holds a JSON object/array (double-encoded JSON). */
export function parseNestedJson(s: string): Json[] | { [k: string]: Json } | null {
  const t = s.trim()
  if (t.length < 2 || !looksLikeContainer(t)) return null
  try {
    const v = JSON.parse(t) as Json
    return v !== null && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

export function isJsonType(type: string): boolean {
  return /^json$/i.test(type)
}
