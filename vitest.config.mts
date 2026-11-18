import { defineConfig } from 'vitest/config'

// Unit tests need nothing running; db tests use the seeded databases from `npm run db:up`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/test/*.test.ts'],
          exclude: ['src/**/test/*.db.test.ts']
        }
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['src/**/test/*.db.test.ts'],
          testTimeout: 30_000,
          fileParallelism: false
        }
      }
    ]
  }
})
