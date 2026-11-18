import { describe, expect, it } from 'vitest'
import { SPLIT_RULES, splitStatements, statementAt } from './sqlSplit'

const texts = (sql: string, rules = SPLIT_RULES.mysql): string[] => splitStatements(sql, rules).map((s) => s.text)

describe('splitStatements', () => {
  it('splits on semicolons outside quotes and comments', () => {
    expect(texts("SELECT 1; SELECT 'a;b'; -- c;\nSELECT 2 /* ; */")).toEqual(["SELECT 1", "SELECT 'a;b'", '-- c;\nSELECT 2 /* ; */'])
  })

  it('drops comment-only segments', () => {
    expect(texts('SELECT 1; -- done')).toEqual(['SELECT 1'])
  })

  it('treats # as a comment only in MySQL', () => {
    expect(texts('SELECT 1 # ;\n', SPLIT_RULES.mysql)).toEqual(['SELECT 1 # ;'])
    expect(texts('SELECT 1 # 2; SELECT 3', SPLIT_RULES.postgres)).toEqual(['SELECT 1 # 2', 'SELECT 3'])
  })

  it('keeps PostgreSQL dollar-quoted bodies whole', () => {
    expect(texts('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT 2', SPLIT_RULES.postgres)).toEqual([
      'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql',
      'SELECT 2'
    ])
  })

  it('keeps SQL Server bracket identifiers whole', () => {
    expect(texts('SELECT [a;b] FROM t; SELECT 2', SPLIT_RULES.mssql)).toEqual(['SELECT [a;b] FROM t', 'SELECT 2'])
  })
})

describe('statementAt', () => {
  it('returns the statement under the cursor', () => {
    const sql = 'SELECT 1;\nSELECT 2;'
    expect(statementAt(sql, sql.indexOf('2'))?.text).toBe('SELECT 2')
  })
})
