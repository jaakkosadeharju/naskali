import { describe, expect, it } from 'vitest'
import { SPLIT_RULES, isPlainSelect, splitStatements, statementAt } from '../sqlSplit'

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

describe('isPlainSelect', () => {
  const all = Object.entries(SPLIT_RULES)

  it.each(all)('accepts read-only queries (%s)', (_, rules) => {
    for (const sql of [
      'SELECT * FROM customers',
      '  select id from t where id = 1;',
      '/* note */ SELECT 1',
      '-- note\nSELECT 1',
      'WITH x AS (SELECT 1 AS a) SELECT a FROM x',
      'TABLE customers',
      'SELECT updated_at, last_update FROM t',
      'SELECT * FROM t FOR UPDATE'
    ]) {
      expect(isPlainSelect(sql, rules), sql).toBe(true)
    }
  })

  it.each(all)('rejects statements that write or run code (%s)', (_, rules) => {
    for (const sql of [
      'INSERT INTO t SELECT * FROM u',
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone',
      'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x',
      'SELECT * INTO backup FROM t',
      'SELECT a INTO @v FROM t',
      'CALL proc()',
      'EXEC proc',
      'MERGE INTO t USING u ON 1 = 1 WHEN MATCHED THEN DELETE',
      'REPLACE INTO t VALUES (1)',
      'SELECT 1; SELECT 2',
      'SET @a = 1',
      ''
    ]) {
      expect(isPlainSelect(sql, rules), sql).toBe(false)
    }
  })

  it('ignores keywords inside strings, comments and quoted identifiers', () => {
    expect(isPlainSelect("SELECT 'delete from t' AS s, `update` FROM t # insert", SPLIT_RULES.mysql)).toBe(true)
    expect(isPlainSelect('SELECT "delete", $$ update $$ FROM t /* into */', SPLIT_RULES.postgres)).toBe(true)
    expect(isPlainSelect('SELECT [merge], N\'exec\' FROM t -- call', SPLIT_RULES.mssql)).toBe(true)
  })
})
