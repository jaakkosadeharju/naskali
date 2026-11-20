# Developing Naskali

Use Node.js 24 and npm. Docker Compose is required only for the server database demos and their integration tests.

```sh
npm ci
npm run dev
```

## Demo databases

Each demo uses the same sample shop data. Create the SQLite file with `npm run db:sqlite`, start MySQL and PostgreSQL with `npm run db:up`, or start all three server databases with `npm run db:up:mssql`.

| Database | Host or file | Login | Database |
| --- | --- | --- | --- |
| MySQL 8.4 | `127.0.0.1:3306` | `dev` / `dev` | `shop` |
| PostgreSQL 17 | `127.0.0.1:5432` | `dev` / `dev` | `shop` |
| SQL Server Developer | `127.0.0.1:14330` | `sa` / `Naskali!Dev1` | `shop` |
| SQLite | `dev/shop.sqlite` | | |

For the SQL Server demo, enable **Trust server certificate** in Naskali. Starting the SQL Server container downloads an image of roughly 1.5 GB and accepts Microsoft's SQL Server EULA. Run `npm run db:down` to stop the demo containers.

The demo includes an `order_details` view on all four engines, plus a `line_total` function
and a `customer_order_count` procedure on the three server engines. The explorer lists
stored procedures on SQL Server.

If you already have a running demo, add the examples without reseeding the tables:

```sh
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot shop' < docker/examples.mysql.sql
docker compose exec -T postgres psql -U dev -d shop -v ON_ERROR_STOP=1 < docker/examples.postgres.sql
docker compose exec -T mssql sh -c 'exec /opt/mssql-tools18/bin/sqlcmd -C -I -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD"' < docker/examples.mssql.sql
```

To add the view to an existing SQLite demo, run the `CREATE VIEW order_details` statement
at the end of [the SQLite seed](../docker/seed.sqlite.sql).

## Checks and builds

| Command | Purpose |
| --- | --- |
| `npm test` | Run Vitest unit tests without a database |
| `npm run test:db` | Run integration tests against the seeded server databases |
| `npm run typecheck` | Check TypeScript types |
| `npm run build` | Bundle the app into `out/` |
| `npm run preview` | Run the built app |
| `npm run dist:linux` | Build an AppImage and Debian package into `dist/` |

## Architecture

```
src/
  main/       Electron main process (Node): window, IPC handlers
    drivers/            Driver interface + mysql, postgres, mssql, sqlite (+ sqliteWorker) implementations;
                        each normalizes its catalog (key 'PRI', type 'BASE TABLE'/'VIEW', 'GENERATED')
    dialect.ts          per-database SQL differences (quoting, placeholders, paging, single-row DML, literals)
    tableQuery.ts       filter rows → parameterized WHERE; change sets → DELETE/UPDATE/INSERT (validated)
    session.ts          table data paging, change preview/apply on top of any driver
    querySessions.ts    per-tab editor connections and transactions
    resultEditing.ts    editable column and row identity checks for query results
    tableSchema.ts      SQL generation for table design actions
    connectionStore.ts  saved connections (userData/connection.json)
  preload/    contextBridge → window.api (the only renderer↔Node bridge)
  shared/     types shared across processes (SqlApi, QueryResult, …) + editing rules
    sqlSplit.ts         statement splitter with per-dialect quoting and comment rules
  renderer/   React UI (sandboxed, no Node)
    src/completion.ts   Monaco completion provider
    src/components/     SqlEditor, ResultsGrid, SchemaTree, ConnectDialog,
                        TableView (+ FilterBar, TableSchemaView, SqlPreviewModal)
```

Database drivers live only in the main process. The renderer is sandboxed (`contextIsolation`, no `nodeIntegration`, strict CSP) and Monaco is bundled locally, so the app doesn't need a CDN.

The database dependencies require no native npm add-on rebuilds. SQLite uses the runtime's built-in `node:sqlite` module.

## Engine and editing limitations

- Table edits check that the target row still exists. Saving can overwrite a concurrent edit to the same row. The table pager uses `COUNT(*)`, which can be slow on large tables.
- Views and tables without a primary key are read-only in the Data view. Generated, binary, and spatial columns are also read-only. Use SQL to replace a NULL with an empty string.
- The editor does not support MySQL `DELIMITER` blocks or SQL Server `GO` separators. MySQL returns `1` when `SELECT SLEEP(n)` is cancelled.
- For PostgreSQL and SQL Server, the Schema view reconstructs table DDL from the catalog and displays the stored definitions for views.
- SQL Server `decimal` and `numeric` values arrive as JavaScript numbers and can lose precision. `date` and `time` values display as full timestamps. Use qualified names to query across schemas.
- SQLite integers outside JavaScript's safe range are displayed as exact decimal text. Pages with primary keys that cannot round-trip through the grid are read-only.
- The app keeps up to 100,000 loaded rows per query result in memory. MySQL counts rows beyond the cap. PostgreSQL, SQL Server, and SQLite stop reading at the cap.

## Releases

Bump the stable version with `npm version patch --no-git-tag-version` (or use `minor` or `major`), then commit the
manifest and lockfile changes. When the bump reaches `master`, GitHub Actions tests and packages Linux x64
(AppImage and DEB), Windows x64 (EXE), and macOS (universal DMG). After all three builds succeed, it publishes
the installers and generated release notes under the corresponding `vX.Y.Z` tag. The workflow builds unsigned
installers and can also be run manually from the Actions tab on `master` for the current version.

See the [release workflow](../.github/workflows/release.yml) for build and publishing steps.
