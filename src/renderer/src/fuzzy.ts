// Small fuzzy matcher for the table palette: the query's characters must appear
// in order (case-insensitive). Scoring favours matches at word starts
// (start, after _ . - or a lower→upper case change), runs of consecutive
// characters and early matches – so "oi" ranks "order_items" above "invoices".

export interface FuzzyMatch {
  score: number
  /** Indices of matched characters in the text, for highlighting. */
  positions: number[]
}

const isBoundary = (text: string, i: number): boolean =>
  i === 0 || '_.- '.includes(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]))

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  // Exact substring beats everything else; prefer it at a word boundary / start.
  const sub = t.indexOf(q)
  if (sub >= 0) {
    const positions = Array.from({ length: q.length }, (_, k) => sub + k)
    return { score: 1000 + (sub === 0 ? 200 : isBoundary(text, sub) ? 100 : 0) - sub - text.length, positions }
  }

  // Otherwise a subsequence. For each query char, prefer the next word-boundary
  // occurrence over the very next occurrence (cheap stand-in for full DP).
  const positions: number[] = []
  let from = 0
  for (const ch of q) {
    let pick = -1
    for (let i = from; i < t.length; i++) {
      if (t[i] !== ch) continue
      if (pick < 0) pick = i
      // Keep a consecutive match; otherwise jump ahead to a word start if there is one.
      if (i === from && positions.length > 0) {
        pick = i
        break
      }
      if (isBoundary(text, i)) {
        pick = i
        break
      }
    }
    if (pick < 0) return null
    positions.push(pick)
    from = pick + 1
  }

  // Every character at a word start ("oi" → Order_Items) reads as an acronym: rank it
  // between a word-start substring (~1100) and a mid-word substring (~1000).
  let score = positions.every((p) => isBoundary(text, p)) ? 1000 : 0
  positions.forEach((p, k) => {
    if (isBoundary(text, p)) score += 30
    if (k > 0 && p === positions[k - 1] + 1) score += 20
  })
  score -= positions[0] // earlier is better
  score -= (positions[positions.length - 1] - positions[0]) / 2 // tighter is better
  score -= text.length / 4 // shorter names win ties
  return { score, positions }
}
