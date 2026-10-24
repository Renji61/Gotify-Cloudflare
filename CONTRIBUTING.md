# Contributing

Thanks for helping. This project runs the Gotify server (v3.1.1) on Cloudflare
Workers and serves the official, unmodified Gotify web UI.

## Project layout

- `src/worker.ts`: entry point and the `GotifyStore` Durable Object. `/` and
  `/index.html` are filled in by the Worker, static files come from the assets,
  everything else goes to the Durable Object, which is also the WebSocket hub.
- `src/server.ts`: the Gotify server (routing, authentication, API handlers),
  ported from upstream's `router/`, `api/`, `auth/`, `model/` and `database/`.
- `src/store.ts`, `src/storage.ts`: database queries and schema. The same code
  runs on Node's SQLite in tests.
- `src/tokens.ts`, `src/bcrypt.ts`, `src/ed25519ph.ts`: tokens and passwords.
- `src/version.ts`: the reported Gotify version.
- `scripts/prepare-ui.mjs`: builds the official UI at the pinned tag into `public/`.
- `scripts/import-gotify.mjs`: sends an existing `gotify.db` to `POST /_import`.
- `test/`: tests, run through `test/harness.ts` on in-memory SQLite (not workerd).

## Development

- `npm install`, then `npm test` (needs Node 22.13+) and `npm run typecheck`.
- `npm run prepare-ui` builds the web UI into `public/`. The first run takes a few minutes.
- `npm run dev` runs the app locally at http://localhost:8787. Copy
  `.dev.vars.example` to `.dev.vars`, set `GOTIFY_DEFAULTUSER_PASS`, and add
  `GOTIFY_SERVER_SECURECOOKIE=false` (plain http; Safari refuses `Secure` cookies).

## Rules for changes

- Keep behaviour identical to upstream Gotify v3.1.1: paths, status codes, JSON
  field names and order, error bodies and token formats. The unmodified web UI
  and Android app depend on it.
- Deliberate divergences are documented in comments in `src/*.ts` and
  `wrangler.jsonc`, and in the README's "Features and limits" section. Don't add new ones
  without documenting them in those places.
- Add or update tests in `test/` for every behaviour change, and keep `npm test` green.
- Keep `observability.logs.invocation_logs: false` in `wrangler.jsonc`:
  `/stream?token=` carries client tokens in the URL.
- Don't add server-side WebSocket pings or timers that keep the Durable Object
  awake. Hibernation depends on that.
- Keep password hashing (bcrypt) inside the Durable Object, not in the Worker.
- Plugins, OIDC and MCP are out of scope.

## Updating to a new Gotify release

See "Staying up to date" in the README for the user side. For a port:

1. Change `gotify.tag` in `package.json` and update `src/version.ts` (version,
   commit, and the tag's commit date) and the `version` field.
2. Diff upstream between the old and new tags:
   `git diff vOLD vNEW -- router/ api/ auth/ model/ database/ config/`.
   Changes under `ui/` need no code change; the UI is rebuilt from the tag.
3. Port relevant changes into `src/`, add or adjust tests, then run `npm test`
   and `npm run typecheck`. A schema change needs a migration in `src/storage.ts`.

## Pull requests

- Keep each pull request focused, and make sure `npm test` and
  `npm run typecheck` pass.
- Pull requests are welcome; accepted changes are committed by the maintainer.
- The Contributors check fails on pull requests from anyone but the maintainer; this is expected.
