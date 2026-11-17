# Naskali (POC)

A desktop SQL client proof of concept: **Electron + React + Monaco + Glide Data Grid**, talking to **MySQL** via `mysql2`.

## Quick start

```sh
npm install
npm run db:up      # MySQL 8.4 in Docker with a seeded `shop` database (user dev/dev)
npm run dev        # app with hot reload
```

Connect with `127.0.0.1:3306`, user `dev`, password `dev`, database `shop`.

| Script | |
|---|---|
| `npm run dev` | Electron + Vite dev server with HMR |
| `npm run build` | Production bundle into `out/` |
| `npm run typecheck` | TypeScript check |
| `npm run dist:linux` | AppImage + .deb into `dist/` |
| `npm run db:down` | Stop the MySQL container |

## Features

- **Ctrl+Enter** runs the selection, or the statement under the cursor (quote/comment-aware `;` splitting)
- Cancel a running query (`KILL QUERY` over a separate metadata connection)
- Virtualized results grid (100k-row cap per result; copy cells with Ctrl+C)
- Schema tree with filter; double-click a database to `USE` it, a column to insert its name
- **Table tabs**: hover a table in the tree → **Data** / **Schema** (double-click opens Data). Each tab has a Data | Schema toggle
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
- **Table palette** – **Ctrl+P** (⌘P on macOS) from anywhere: fuzzy search over all tables (word-start acronyms like
  `oi` → `order_items`; type `schema.table` to search across databases), recently opened tables first.
  Enter opens the Data view, Ctrl/⌘+Enter the Schema view, Esc returns to where you were
- Schema-aware autocomplete: tables, columns, `alias.` → columns, `db.` → tables
- Remembers the last connection; the password is stored only if an OS keyring is available (`safeStorage`)

## Architecture

```
src/
  main/       Electron main process (Node): window, IPC handlers
    mysql.ts            MySqlSession – editor connection + metadata connection
    tableQuery.ts       filter rows → parameterized WHERE; change sets → DELETE/UPDATE/INSERT (validated)
    connectionStore.ts  saved connection (userData/connection.json)
  preload/    contextBridge → window.api (the only renderer↔Node bridge)
  shared/     types shared across processes (SqlApi, QueryResult, …) + editing rules
  renderer/   React UI (sandboxed, no Node)
    src/completion.ts   Monaco completion provider
    src/sqlSplit.ts     statement splitter
    src/components/     SqlEditor, ResultsGrid, SchemaTree, ConnectDialog,
                        TableView (+ FilterBar, TableSchemaView, SqlPreviewModal)
```

Database drivers live only in the main process. The renderer is sandboxed (`contextIsolation`, no `nodeIntegration`, strict CSP) and Monaco is bundled locally, so the app doesn't need a CDN.

## Known POC limitations / next steps

- One connection and one query editor; no query history or export yet
- No optimistic-concurrency check beyond "row still exists" (a concurrent change to the same row is overwritten);
  no sorting by column header yet;
  `COUNT(*)` for the pager can be slow on huge tables
- Editing an empty value into a NULL cell is treated as "no change" (use a SQL statement to store `''` there)
- All rows are kept in memory up to the cap; a real version should page or stream into the grid
- `DELIMITER` blocks (stored procedure bodies) aren't split
- `SELECT SLEEP(n)` returns `1` when cancelled (that's MySQL behaviour); real queries report "interrupted"
- To support other databases, put a `Driver` interface in front of `MySqlSession`
