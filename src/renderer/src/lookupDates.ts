/** Date boundaries in the local calendar, formatted for the column's SQL type. */
export function lookupDates(now: Date, kind: 'date' | 'timestamp', sqlServer: boolean) {
  const year = now.getFullYear()
  const month = now.getMonth()
  const day = now.getDate()
  const pad = (value: number) => String(value).padStart(2, '0')
  const format = (date: Date): string => {
    const text = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    return kind === 'date' ? text : `${text}${sqlServer ? 'T' : ' '}00:00:00`
  }
  return [
    { label: 'Today', value: format(new Date(year, month, day)) },
    { label: 'Yesterday', value: format(new Date(year, month, day - 1)) },
    { label: 'Start of this month', value: format(new Date(year, month, 1)) },
    { label: 'Start of last month', value: format(new Date(year, month - 1, 1)) },
    { label: 'Start of this year', value: format(new Date(year, 0, 1)) }
  ]
}
