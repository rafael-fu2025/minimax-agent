# Contributing

Thanks for stopping by. This document covers the day-to-day mechanics of
working on the project. The high-level product overview lives in
[README.md](README.md).

## Setup

1. Clone the repo.
2. Install Node.js 20+ (Vite 6 requires it) and Docker (for the optional
   Postgres + pgvector stack). No global pnpm/yarn is needed; npm is fine.
3. `npm install`.
4. `cp .env.example .env` and set `MINIMAX_API_KEY`. The database
   connection string is optional — the server runs stateless without it.
5. `npm run dev` boots both Vite (`http://localhost:5173`) and Express
   (`http://localhost:8787`) with file watching.

Optional DB stack:

```bash
npm run db:up          # docker compose up -d postgres (pgvector)
npm run db:migrate     # apply server/db/migrations/*
npm run db:reindex     # idempotent embeddings backfill
```

## Development workflow

### Scripts

Script            | Purpose
----------------- | --------------------------------------------------------
`npm run dev`     | Concurrent Vite + `tsx watch server/index.ts`.
`npm test`        | One-shot Vitest run; suites live under `tests/`.
`npm run test:watch` | Vitest watch mode.
`npm run build`   | `tsc -b && vite build`. Run before pushing.
`npm run db:studio` | Drizzle Studio for the local DB.

### Verifying before a commit

The three commands we run on every PR. If any fails, please fix it before
asking for review:

```bash
npx tsc --noEmit -p tsconfig.json   # type-check both server + web
npx vitest run                     # 132 tests; fast (~10 s)
npx vite build                     # production bundle smoke test
```

### Code conventions

- **React 19 + hooks only.** No class components, no `react-query`.
- **Astryx primitives first.** Wrap with `@astryxdesign/core` components
  (`Dialog`, `ToastHost`, `TreeList`, `Button`, `IconButton`, etc.) before
  reaching for raw HTML. The codebase keeps app-level chrome (composer,
  message list, sidebar) on the design system.
- **Vitest for tests.** We do **not** depend on `@testing-library/react`
  or jsdom. Tests that need to exercise an HTTP route spin up a real
  Express app on `127.0.0.1:0`; component tests use the minimal
`renderHook` helper at `tests/_helpers/renderHook.ts` (raw
`react-dom/client` + `act`).
- **No unit tests for CSS.** Visual regressions are reviewed in PRs.
- **Path-safe FS everywhere.** Every server-side path-mutation goes
  through `server/tools/sandbox.ts:resolveSafePath()`. Absolute paths,
  `..` traversal, and symlink escapes return `400`. If you add a new
  route that touches the filesystem, route its paths through the same
  helper.
- **Trash = rename-to-`.trash/`.** Reversible on disk. Do **not** reach
  for `node:fs/promises.rm`; the Workspace Explorer Undo flow relies on
  the rename pattern.

### Editing source on Windows / PowerShell

PowerShell's single-quote parsing mangles apostrophes inside JS string
literals, which routinely breaks `apply_patch` calls. We work around it
by writing throw-away JS to `tools/_*.cjs` files and running them via
`node tools/_<name>.cjs`, then deleting the file. The convention is
covered by a `.gitignore` rule so these never get committed.

If you ever see `[your-file].bak` files lying around from `apply_patch`
falls, please delete them.

## Pull requests

- One change per PR. Refactors + behavior changes do not mix.
- Branch from `main`. Use a descriptive name (`fix/workspace-undo-on-fail`,
  `feat/toast-action-pending`).
- Run the three checks above before opening the PR.
- If your change touches a native tool or sandbox router, also run the
  targeted suite (e.g. `npx vitest run tests/server/sandbox-router.test.ts`)
  and add a test for any new endpoint / behavior.
- PRs with UI changes must include a screenshot or short screen recording.
  PRs without one will be asked to add one.

## Reporting bugs

Open an issue with:

- Reproduction steps (exact user input matters for tool-call bugs).
- The relevant log lines from the server (`npm run dev` shows them inline)
  and, if the DB is involved, the most recent `SELECT` from
  `conversations` / `messages`.
- The model id you were running (`/api/models` lists them).

For security issues, please email rather than filing a public issue —
this app is a sandbox that runs shell + write tools on your machine.
