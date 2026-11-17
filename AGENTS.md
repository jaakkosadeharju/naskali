# Repository Guidelines

## Project Structure

Naskali is a desktop SQL client built with Electron, React, Monaco, and Glide Data Grid.

- `src/main/` owns the Electron window, IPC handlers, database access, and connection storage. Table filtering and edit SQL live in `tableQuery.ts`.
- `src/preload/index.ts` exposes the typed `window.api` bridge. Keep shared IPC types and editing rules in `src/shared/`.
- `src/renderer/src/` contains the React UI, Monaco integration, and SQL statement splitting. Look in `components/` for UI components and `assets/` for the renderer logo.
- `resources/` contains runtime icons and splash assets. `build/` holds packaging icons, and `docker/seed.sql` initializes the local MySQL database.

## Build and Development

- `npm ci` installs dependencies from the committed lockfile.
- `npm run db:up` starts seeded MySQL 8.4. Connect to `127.0.0.1:3306` with user `dev`, password `dev`, and database `shop`. Run `npm run db:down` when finished.
- `npm run dev` starts Electron with hot reload. `npm run preview` runs the built app.
- `npm run build` bundles the app into `out/`. `npm run dist:linux` builds Linux AppImage and Debian packages in `dist/`.

## Coding Style

Use strict TypeScript, two-space indentation, single quotes, and semicolon-free statements. Use PascalCase for React component files (such as `ResultsGrid.tsx`) and camelCase for helpers (such as `sqlSplit.ts`). Follow nearby formatting. Keep database access in the main process, route renderer calls through `window.api`, and bind values in generated SQL.

## Testing

Run `npm run typecheck` and `npm run build` before submitting. The repository currently has no automated test runner, test naming convention, or coverage threshold. Smoke-test affected workflows with `npm run dev` and the seeded database. For table editing changes, verify that successful edits persist and failed batches roll back.

## Commits and Pull Requests

Use short, descriptive commit subjects, as in `link to foreign key target`. In pull requests, explain the user-visible change and list the checks you ran. Link related issues when available and include screenshots for visible UI changes.
