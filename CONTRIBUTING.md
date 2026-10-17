# Contributing

Thanks for helping! Sheetah is a static site: everything runs in the browser, so most changes are TypeScript in
`src/` plus a test.

## Setup

```bash
nvm use            # Node 22 (.nvmrc)
npm ci
npx playwright install chromium
npm run dev        # http://localhost:5173
```

## Before you open a pull request

```bash
npm run lint
npm run test:unit  # seconds
npm test           # builds, then unit + end-to-end + perf against the production build
```

- **New behaviour gets a test.** Pure logic (SQL building, parsing, formatting) goes in `tests/unit/*.test.ts`.
  Keep SQL builders free of the engine import (like `compare-sql.ts`, `clean.ts`, `lookup.ts`) so unit tests can
  run what they build on DuckDB in Node with `q()` from `tests/unit/duck.ts`: assert on rows, not on SQL text.
  Anything that needs the UI goes in `tests/*.spec.ts`. End-to-end tests run against `vite preview`,
  which sends the production security headers, so they catch CSP problems too.
- **UI actions write SQL.** Sorting, filtering, cleaning, look-ups, pivots, compare and anonymize all compile to SQL that lands in the
  editor. Keep that SQL readable: it's how people learn what the app did.
- **Nothing leaves the tab.** Don't add network calls, third-party scripts or new hosts to the CSP in `vercel.json`.
  The engine is sealed (`src/engine/db.ts`); don't load anything after sealing.
- **Use the right connection.** User SQL and file loads go through `runSql` / `withRunLock` (cancellable, one at a
  time). App reads use `getEngine().conn` with `query()`. Never call `send()` on `conn`.
- **Copy:** plain language, sentence case, no jargon in the UI. See `docs/ux-copy.md`.

## Security issues

Please report privately via GitHub (Security → Report a vulnerability), not in a public issue. See
[SECURITY.md](SECURITY.md).
