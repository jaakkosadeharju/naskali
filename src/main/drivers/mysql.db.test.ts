import { MySqlDriver } from './mysql'
import { driverSuite } from '../testing/driverSuite'

driverSuite('MySQL', () => new MySqlDriver({ driver: 'mysql', host: '127.0.0.1', port: 3306, user: 'dev', password: 'dev', database: 'shop' }), {
  schema: 'shop',
  q: (n) => `\`${n}\``
})
