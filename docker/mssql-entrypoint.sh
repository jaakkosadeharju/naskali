#!/bin/bash
# Starts SQL Server and creates the `shop` sample database on first start
# (re-creating it if an earlier seed attempt didn't finish).
/opt/mssql/bin/sqlservr &
server=$!
# -I: QUOTED_IDENTIFIER ON (needed for the filtered index); -f 65001: read the seed as UTF-8.
sqlcmd() { /opt/mssql-tools18/bin/sqlcmd -C -I -S localhost -U sa -P "$MSSQL_SA_PASSWORD" "$@"; }
for _ in $(seq 1 90); do sqlcmd -Q "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
state=$(sqlcmd -h -1 -W -Q "SET NOCOUNT ON; SELECT CASE WHEN DB_ID('shop') IS NULL THEN 'missing' WHEN OBJECT_ID('shop.dbo.events') IS NULL THEN 'partial' ELSE 'ready' END")
if [ "$state" != "ready" ]; then
  [ "$state" = "partial" ] && sqlcmd -Q "ALTER DATABASE shop SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE shop;"
  echo "Seeding the shop database…"
  if sqlcmd -f 65001 -b -i /seed/seed.mssql.sql && sqlcmd -f 65001 -b -i /seed/examples.mssql.sql; then
    echo "Seeded."
  else
    echo "Seeding FAILED (see above)."
  fi
fi
wait $server
