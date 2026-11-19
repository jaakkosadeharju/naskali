import { expect, it } from 'vitest'
import { buildSchemaTree } from '../types'

it('includes function-only schemas and keeps PostgreSQL overloads distinct', () => {
  expect(buildSchemaTree(['public'], [], [], [
    { schema: 'utilities', name: 'normalize(integer)' },
    { schema: 'utilities', name: 'normalize(text)' }
  ])).toEqual([
    { name: 'public', tables: [] },
    { name: 'utilities', tables: [], functions: ['normalize(integer)', 'normalize(text)'] }
  ])
})
