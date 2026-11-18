import { PostgresDriver } from '../postgres'
import { driverSuite } from '../../test/driverSuite'

driverSuite('PostgreSQL', () => new PostgresDriver({ driver: 'postgres', host: '127.0.0.1', port: 5432, user: 'dev', password: 'dev', database: 'shop' }), {
  schema: 'public',
  q: (n) => `"${n}"`
})
