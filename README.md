# Naskali

Naskali is a desktop SQL client for **MySQL and MariaDB, PostgreSQL, SQL Server, and SQLite**. Use it to write queries, explore unfamiliar schemas, and inspect or edit data in a grid.

[Download Naskali](https://github.com/jaakkosadeharju/naskali/releases) for Windows (x64 EXE), macOS (universal DMG), or Linux (x64 AppImage and DEB). Installers are unsigned.

## Get familiar with the app

1. **Connect to a database.** Choose an engine in the connection dialog and enter your server details, or browse to a SQLite file. Save a named profile to restore your workspace, including open tabs, SQL drafts, editor splits, and applied table filters.
2. **Find a table.** Browse the explorer or press **Ctrl+P** (**⌘P** on macOS) to search in the table palette. Press **Enter** for the Data view or **Ctrl/⌘+Enter** for Schema. Try `orders#total>=100` in the palette to look up matching rows.
3. **Run a query.** Open **New query** and press **Ctrl+Enter** to run the selected SQL or the statement under the cursor. The editor suggests tables and columns from the connected database.

## Key features

- **Query workspace.** Keep independent SQL sessions in separate tabs, cancel running queries, and open, commit, or roll back a transaction from its tab. Save reusable queries and mark database objects as favourites.
- **Data and schema browser.** Browse paged table data, build server-side filters, and open the generated SQL in the editor. Inspect columns, indexes, foreign keys, and DDL in the Schema view. Follow foreign-key links directly to related rows.
- **Reviewable data edits.** Edit, add, or delete rows in tables with a primary key. Eligible query results also support cell edits when the source row can be identified. Preview the SQL before applying a batch of changes in a transaction.
- **Value inspector.** Inspect long values and browse nested JSON in a tree, formatted text, or raw text. Edit supported values with JSON validation and save them alongside your other pending edits.
- **Table design.** Create tables and make supported column changes from the explorer. Open the generated SQL for a new table in the editor.
- **Copy and export.** Copy selected grid cells or export loaded query results and the current filtered table page as CSV or JSON. Query results load up to 100,000 rows per result.

## Run from source

With Node.js 24 and npm installed, run:

```sh
npm ci
npm run db:sqlite
npm run dev
```

In the connection dialog, choose **SQLite** and open `dev/shop.sqlite` from the project directory. Try the `order_details` view to explore the demo data. See the [developer guide](docs/development.md) for Docker-backed demos, test commands, engine limitations, and release steps.

## Project layout

Naskali uses Electron and TypeScript, with React for the interface, Monaco for the SQL editor, and Glide Data Grid for tabular data.

| Directory | What you’ll find |
| --- | --- |
| [`src/main`](src/main) | Electron main process, database drivers, query sessions, and SQL generation |
| [`src/preload`](src/preload) | Typed bridge between the sandboxed renderer and the main process |
| [`src/shared`](src/shared) | Shared API types, SQL splitting, and editing rules |
| [`src/renderer`](src/renderer) | Workspace, SQL editor, explorer, data grid, and value inspector |
| [`docker`](docker) | Seed data and example SQL for the demo databases |

## License

[MIT](LICENSE)
