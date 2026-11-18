import { describe } from 'vitest'
import { MssqlDriver } from './mssql'
import { driverSuite } from '../testing/driverSuite'

// SQL Server is opt-in (npm run db:up:mssql): set NASKALI_MSSQL=1 to run these.
describe.runIf(process.env.NASKALI_MSSQL === '1')('SQL Server', () => {
  driverSuite(
    'driver',
    () =>
      new MssqlDriver({
        driver: 'mssql',
        host: '127.0.0.1',
        port: 14330,
        user: 'sa',
        password: 'Naskali!Dev1',
        database: 'shop',
        trustServerCertificate: true
      }),
    { schema: 'dbo', q: (n) => `[${n}]` }
  )
})
