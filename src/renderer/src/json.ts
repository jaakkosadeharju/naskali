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

// ---- Editing ------------------------------------------------------------------

export type JsonKey = string | number

/**
 * Returns a copy of `node` with the value at `path` replaced. A path may run
 * through a string holding JSON (double-encoded); that string is re-encoded.
 */
export function setAtPath(node: Json, path: JsonKey[], value: Json): Json {
  if (path.length === 0) return value
  if (typeof node === 'string') {
    const nested = parseNestedJson(node)
    if (!nested) throw new Error('Path runs into a plain string')
    return serializeLike(setAtPath(nested, path, value), node, false)
  }
  const [k, ...rest] = path
  if (Array.isArray(node)) {
    const copy = node.slice()
    copy[k as number] = setAtPath(copy[k as number], rest, value)
    return copy
  }
  if (node !== null && typeof node === 'object') {
    return { ...node, [k]: setAtPath(node[k as string], rest, value) }
  }
  throw new Error('Path runs into a primitive value')
}

/**
 * Serializes edited JSON the way the original was written: compact for JSON
 * columns (MySQL normalizes them anyway) and for single-line text; otherwise
 * pretty-printed with the original's indentation.
 */
export function serializeLike(json: Json, original: string, isJsonColumn: boolean): string {
  if (isJsonColumn || !original.includes('\n')) return JSON.stringify(json)
  const indent = /\n([ \t]+)\S/.exec(original)?.[1] ?? 2
  return JSON.stringify(json, null, indent)
}

/**
 * Interprets text typed for a JSON leaf, keeping the leaf's type: strings take
 * the text as-is (no quotes needed), numbers/booleans must stay numbers/booleans,
 * and null accepts any JSON literal (falling back to a string).
 */
export function parseLeafInput(input: string, original: Json): { ok: true; value: Json } | { ok: false; error: string } {
  if (typeof original === 'string') return { ok: true, value: input }
  const t = input.trim()
  if (typeof original === 'number') {
    const n = Number(t)
    return t !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'Expected a number' }
  }
  if (typeof original === 'boolean') {
    return t === 'true' || t === 'false' ? { ok: true, value: t === 'true' } : { ok: false, error: 'Expected true or false' }
  }
  try {
    return { ok: true, value: JSON.parse(t) as Json }
  } catch {
    return { ok: true, value: input }
  }
}

/**
 * Explains why `text` isn't valid JSON as "Line L, column C: problem". V8's
 * JSON.parse messages no longer carry a position (and embed the whole input),
 * so this runs a small validating scanner to locate the first error.
 */
export function describeJsonError(text: string): string {
  let i = 0
  const fail = (msg: string): never => {
    throw Object.assign(new Error(msg), { at: i })
  }
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  }
  const show = (): string => (i >= text.length ? 'end of input' : JSON.stringify(text[i]))
  const literal = (word: string): void => {
    if (text.startsWith(word, i)) i += word.length
    else fail(`Unexpected ${show()}`)
  }
  const string = (): void => {
    i++ // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        i++
        if (text[i] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail('Bad \\u escape')
          i += 4
        } else if (!'"\\/bfnrt'.includes(text[i] ?? '')) fail('Bad escape sequence')
      } else if (text.charCodeAt(i) < 0x20) fail('Unescaped control character in string')
      i++
    }
    if (i >= text.length) fail('Unterminated string')
    i++
  }
  const number = (): void => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (!m) fail(`Unexpected ${show()}`)
    i += m![0].length
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') return void i++
      for (;;) {
        ws()
        if (text[i] !== '"') fail(`Expected a quoted key, got ${show()}`)
        string()
        ws()
        if (text[i] !== ':') fail(`Expected ':' after key, got ${show()}`)
        i++
        value()
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') return void i++
        fail(`Expected ',' or '}', got ${show()}`)
      }
    } else if (c === '[') {
      i++
      ws()
      if (text[i] === ']') return void i++
      for (;;) {
        value()
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') return void i++
        fail(`Expected ',' or ']', got ${show()}`)
      }
    } else if (c === '"') string()
    else if (c === 't') literal('true')
    else if (c === 'f') literal('false')
    else if (c === 'n') literal('null')
    else if (c === '-' || (c >= '0' && c <= '9')) number()
    else fail(`Unexpected ${show()}`)
  }
  try {
    value()
    ws()
    if (i < text.length) fail(`Unexpected ${show()} after the JSON value`)
    return 'Invalid JSON'
  } catch (e) {
    const at = (e as { at?: number }).at ?? 0
    const before = text.slice(0, at)
    const line = before.split('\n').length
    const col = at - before.lastIndexOf('\n')
    return `Line ${line}, column ${col}: ${(e as Error).message}`
  }
}
