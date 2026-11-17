// Builds dev/shop.sqlite from docker/seed.sqlite.sql using Node's built-in SQLite (Node 22.5+).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dev', 'shop.sqlite')
mkdirSync(dirname(out), { recursive: true })
rmSync(out, { force: true })
const db = new DatabaseSync(out)
db.exec(readFileSync(join(root, 'docker', 'seed.sqlite.sql'), 'utf8'))
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
console.log(`Created ${out}: ${['customers', 'products', 'orders', 'events'].map((t) => `${t}=${count(t)}`).join(', ')}`)
db.close()
