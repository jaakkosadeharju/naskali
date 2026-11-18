import { describe, expect, it } from 'vitest'
import { MssqlDriver } from '../mssql'
import { driverSuite } from '../../test/driverSuite'

// SQL Server is opt-in (npm run db:up:mssql): set NASKALI_MSSQL=1 to run these.
describe.runIf(process.env.NASKALI_MSSQL === '1')('SQL Server', () => {
  const connectDriver = () => new MssqlDriver({
    driver: 'mssql',
    host: '127.0.0.1',
    port: 14330,
    user: 'sa',
    password: 'Naskali!Dev1',
    database: 'shop',
    trustServerCertificate: true
  })

  driverSuite('driver', connectDriver, { schema: 'dbo', q: (n) => `[${n}]` })

  it('scripts a stored procedure as CREATE after it has been altered', async () => {
    const driver = connectDriver()
    const name = `naskali_definition_${process.pid}`
    const target = `[dbo].[${name}]`
    await driver.connect()
    try {
      const initial = `CREATE PROCEDURE ${target} AS BEGIN SELECT 1; END;`
      await driver.query(initial)
      expect(await driver.procedureDefinition('dbo', name)).toBe(initial)
      expect(await driver.procedureCall('dbo', name)).toBe(`EXEC ${target};`)

      const body = ` PROC ${target} AS BEGIN SELECT 'ALTER PROCEDURE'; END;`
      await driver.query(`-- Keep this comment\nALTER${body}`)
      expect(await driver.procedureDefinition('dbo', name)).toBe(`-- Keep this comment\nCREATE${body}`)

      await driver.query(`CREATE OR ALTER${body}`)
      expect((await driver.procedureDefinition('dbo', name)).replace(/^CREATE\s+/i, 'CREATE ')).toBe(`CREATE${body}`)

      await driver.query(`ALTER PROCEDURE ${target} @id int, @answer int OUTPUT AS SET @answer = @id;`)
      expect(await driver.procedureCall('dbo', name)).toBe(
        `EXEC ${target}\n  @id = <value>,\n  @answer = <value> /* OUTPUT parameter */;`
      )
    } finally {
      try {
        await driver.query(`DROP PROCEDURE IF EXISTS ${target}`)
      } finally {
        await driver.disconnect()
      }
    }
  })
})
