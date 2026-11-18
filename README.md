# Naskali (POC)

A desktop SQL client proof of concept: **Electron + React + Monaco + Glide Data Grid** for
**MySQL, PostgreSQL, SQL Server and SQLite**.

| Database | Driver | Notes |
|---|---|---|
| MySQL / MariaDB | `mysql2` | schemas = databases; double-click one to `USE` it |
| PostgreSQL | `pg` + `pg-cursor` | schemas of the connected database; double-click sets `search_path` |
| SQL Server | `mssql` (tedious) | schemas of the connected database (`dbo`, …) |
| SQLite | Node's built-in `node:sqlite` | Table tools browse `main`. Attached databases are accessible in the editor session. |

All drivers are pure JavaScript, so packaging needs no native rebuilds.

## Quick start

```sh
npm install
npm run db:up        # MySQL 8.4 + PostgreSQL 17 in Docker, both with a seeded `shop` database
npm run db:sqlite    # dev/shop.sqlite with the same data
npm run dev          # app with hot reload
```

| Database | Connect with |
|---|---|
| MySQL | `127.0.0.1:3306`, user `dev` / `dev`, database `shop` |
| PostgreSQL | `127.0.0.1:5432`, user `dev` / `dev`, database `shop` |
| SQL Server | `npm run db:up:mssql` first (opt-in: ~1.5 GB image, accepts Microsoft's SQL Server EULA, Developer edition) → `127.0.0.1:14330` (not 1433, to avoid clashing with a local server), user `sa` / `Naskali!Dev1`, database `shop`, trust server certificate |
| SQLite | `dev/shop.sqlite` |

| Script | |
|---|---|
| `npm run dev` | Electron + Vite dev server with HMR |
| `npm run build` | Production bundle into `out/` |
| `npm run typecheck` | TypeScript check |
| `npm run dist:linux` | AppImage + .deb into `dist/` |
| `npm run db:up` / `db:up:mssql` / `db:down` | Start the MySQL + PostgreSQL / also SQL Server / stop all dev containers |
| `npm run db:sqlite` | (Re)build `dev/shop.sqlite` |

## Features

- The native menu bar groups file, editing, connection, query, view, and help commands. Export and copy commands follow the active tab.

- **New query** opens another SQL tab with its own draft and results. Query tabs share the active database session and run one statement at a time.
- Saved connections restore their open tabs, tab order, SQL drafts, editor splits, and applied table filters. New connections start with an example query.
- Drag query and table tabs to reorder them, or focus a tab and press **Alt+Shift+Left/Right**.
- **Ctrl+Enter** runs the selection, or the statement under the cursor (quote/comment-aware `;` splitting)
- Cancel a running query (MySQL `KILL QUERY`, PostgreSQL `pg_cancel_backend`, SQL Server request cancel, SQLite: the
  editor connection runs in a child process that is killed and reopened – node:sqlite has no interrupt)
- Virtualized results grid (100k-row cap per result; copy cells with Ctrl+C)
- Export loaded query results or the current filtered table page as CSV or JSON. Table exports use saved database values.
- Right-click selected grid cells to copy them as CSV or JSON. **Copy as JSON with headers** uses column names as keys and returns one object for a single selected row or an array of objects for multiple rows.
- Connection dialog with a database-type picker (SQLite: file + Browse…, read-only / create options)
- Schema tree with filter; double-click a schema to make it current (MySQL, PostgreSQL), a column to insert its name
- **Table tabs**: use the **Data** and **Schema** icons beside each table (double-click opens Data). Each tab has a Data | Schema toggle
  - *Schema*: columns, indexes, foreign keys, highlighted DDL
  - *Data*: paged (500 rows, PK-ordered) with a filter builder: column + operator + value rows joined by and/or.
    Operators: `= != < <= > >=`, contains / not contains / starts with / ends with (wildcards escaped), raw `LIKE`/`NOT LIKE`,
    `IN`/`NOT IN` (comma list), `IS [NOT] NULL`. Filtering is server-side and fully parameterized; the generated SQL
    is shown and can be opened in the query editor
- **Row editing** in the Data view (tables with a primary key):
  - *Edit*: double-click a cell; Delete on selected cells sets NULL; paste works
  - *Add*: **+ Add row** inserts a new row at the top; untouched cells show `DEFAULT` (column default / auto_increment)
  - *Delete*: select rows by clicking their numbers (shift/ctrl for more), then **− Delete rows** or the Delete key;
    again to unmark. Deleting a new row just drops it
  - Changes are collected (yellow = edited, green = new, red = deleted; kept across pages/refresh) until you choose
    **Accept**, **View SQL** or **Cancel**. Accept runs deletes → updates → inserts in one transaction on a dedicated
    connection; every statement must affect exactly one row, and any failure (row gone, FK/unique violation, missing
    NOT NULL value) rolls everything back and keeps your pending changes. Closing a tab with pending changes asks first.
  Generated, BLOB/binary and spatial columns are read-only; views and tables without a PK are read-only
- **Value inspector** (right panel; toolbar **◧ Value**, **Ctrl+I**, or double-click a read-only cell): shows the selected
  cell of any result or data grid and follows the selection, also live while you edit. JSON (JSON columns, and text
  that holds a JSON object/array) gets a collapsible tree – with JSON strings nested inside JSON parsed too – plus
  highlighted *Formatted* and *Raw* views; other values show as wrapping text. Resizable (width remembered), closable
- **Editing in the value inspector** (editable table cells): **✎ Edit** opens a text editor (JSON: live validation with
  line/column errors, Format/Minify; invalid JSON can't be stored in a JSON column; Ctrl+Enter applies, Esc cancels),
  or double-click a value in the JSON tree to change just that leaf – also inside JSON strings nested in JSON. Edited
  JSON keeps the original's style (compact vs. pretty-printed). **Set NULL** and **Revert** (new-row cell → `DEFAULT`)
  are there too. Everything becomes a pending change, saved with Accept like grid edits
- **Foreign-key links**: foreign-key cells in the Data view show a small ↗ button that opens the referenced row in a new
  tab, pre-filtered (e.g. `customers id = 2`; composite keys filter on all columns). The same reference reuses its tab;
  the value inspector shows the link as a button too
- **Table palette** – **Ctrl+P** (⌘P on macOS) from anywhere: fuzzy search over all tables (word-start acronyms like
  `oi` → `order_items`; type `schema.table` to search across databases), recently opened tables first.
  Enter opens the Data view, Ctrl/⌘+Enter the Schema view, Esc returns to where you were
- Schema-aware autocomplete: tables, columns, `alias.` → columns, `db.` → tables
- Save named connection profiles in the connection dialog. Select a profile to reconnect, edit it, or remove it. Each profile can set the workspace accent color. Passwords are stored only when OS-backed encryption is available (`safeStorage`).

## Architecture

```
src/
  main/       Electron main process (Node): window, IPC handlers
    drivers/            Driver interface + mysql, postgres, mssql, sqlite (+ sqliteWorker) implementations;
                        each normalizes its catalog (key 'PRI', type 'BASE TABLE'/'VIEW', 'GENERATED')
    dialect.ts          per-database SQL differences (quoting, placeholders, paging, single-row DML, literals)
    tableQuery.ts       filter rows → parameterized WHERE; change sets → DELETE/UPDATE/INSERT (validated)
    session.ts          table data paging, change preview/apply on top of any driver
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

## Known POC limitations / next steps

- One active connection; no query history yet
- No optimistic-concurrency check beyond "row still exists" (a concurrent change to the same row is overwritten);
  no sorting by column header yet;
  `COUNT(*)` for the pager can be slow on huge tables
- Editing an empty value into a NULL cell is treated as "no change" (use a SQL statement to store `''` there)
- All rows are kept in memory up to the cap; a real version should page or stream into the grid
- MySQL `DELIMITER` blocks and SQL Server `GO` separators aren't supported in the editor
- `SELECT SLEEP(n)` returns `1` when cancelled (that's MySQL behaviour); real queries report "interrupted"
- PostgreSQL / SQL Server: the Schema view's DDL is reconstructed from the catalog (columns, PK, FKs, indexes),
  not the server's original definition; views show their real definition
- SQL Server `decimal`/`numeric` values arrive as JS numbers (tedious), so very large/precise values lose precision;
  `date`/`time` columns show as full timestamps. SQL Server can't switch schemas per session (qualify names instead)
- SQLite integers outside JavaScript's safe range are displayed as exact decimal text. Pages with primary keys that cannot round-trip through the grid are read-only.
- PostgreSQL/SQL Server/SQLite results cut off at 100k rows don't count the remaining rows (MySQL does)

## License

Naskali is licensed under the [MIT License](LICENSE).
