import { expect, it } from 'vitest'
import { MySqlDriver } from '../mysql'
import { resultEditInfo } from '../../resultEditing'
import { driverSuite } from '../../test/driverSuite'

const createDriver = () => new MySqlDriver({ driver: 'mysql', host: '127.0.0.1', port: 3306, user: 'dev', password: 'dev', database: 'shop' })

driverSuite('MySQL', createDriver, {
  schema: 'shop',
  q: (n) => `\`${n}\``
})

it('lists the seeded created_at column as editable with a default', async () => {
  const driver = createDriver()
  await driver.connect()
  try {
    const query = 'SELECT id, created_at FROM customers WHERE id = 1'
    const result = await driver.query(query)
    if (result.kind !== 'rows') throw new Error('Expected a result set')
    const info = await resultEditInfo(driver, query, result.fields)
    expect(info.tables[0]?.columns).toContainEqual({ field: 1, column: 'created_at', nullable: false, hasDefault: true })
  } finally {
    await driver.disconnect()
  }
})
