export const ROW_LOOKUP_OPERATORS = ['=', '<=', '<', '>=', '>', 'IS NULL', 'IS NOT NULL'] as const

const LOOKUP_OPERATOR = /[<>]=?|=|\s+IS\s+(?:NOT\s+)?NULL\s*$/i

export function splitRowLookup(expression: string) {
  const match = LOOKUP_OPERATOR.exec(expression)
  if (!match) return null
  return {
    column: expression.slice(0, match.index).trim(),
    operator: match[0].trim().replace(/\s+/g, ' ').toUpperCase(),
    value: expression.slice(match.index + match[0].length).trim()
  }
}
