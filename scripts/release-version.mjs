import { appendFileSync, readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
if (!stable.test(version)) {
  console.log('Automatic releases require a stable major.minor.patch version.')
  process.exit(0)
}

const previous = process.argv[2] ?? (process.env.PREVIOUS_PACKAGE && JSON.parse(process.env.PREVIOUS_PACKAGE).version)
if (previous !== undefined) {
  const old = previous.split(/[+-]/, 1)[0].split('.').map(BigInt)
  const next = version.split('.').map(BigInt)
  const difference = next.findIndex((part, index) => part !== old[index])
  const increased = difference === -1
    ? previous.split('+', 1)[0].includes('-')
    : next[difference] > old[difference]
  if (!increased) {
    console.log(`Version did not increase (${previous} → ${version}).`)
    process.exit(0)
  }
}

const tag = `v${version}`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`)
else console.log(tag)
