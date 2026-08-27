# Running Bison Lawn Care CRM locally

## Prerequisites
- Node 24+ (tested on 26.7.0)
- pnpm 10+ (tested on 11.22.0)
- PostgreSQL 16 reachable from this machine

## First run

```bash
cp .env.example .env      # then fill in the values
pnpm install
pnpm --filter @workspace/db run push       # create the schema
pnpm dlx tsx artifacts/api-server/src/seed.ts   # optional dev data
node dev.mjs
```

`node dev.mjs` starts both processes and prefixes their output:
- API on `API_PORT` (default 3001)
- Web on `WEB_PORT` (default 5173), with `/api` proxied to the API so the browser
  sees a single origin — Clerk's cookie session depends on that.

`node dev.mjs api` and `node dev.mjs web` start one side only.

## Signing in locally

Auth is Clerk. The dev instance in `.env` accepts any account you create on it.
To get admin rather than contractor access, the account's **verified** email must
match `APP_OWNER_EMAIL` or `APP_SECONDARY_OWNER_EMAIL` in `.env`.

Clerk development instances accept test addresses of the form
`anything+clerk_test@yourdomain.com`, which verify with the code `424242` without
sending real mail — useful for local admin access.

## Tests

```bash
DATABASE_URL=postgres://…/bisonlawn_test pnpm --filter @workspace/api-server run test
```

Point `DATABASE_URL` at a throwaway database: the suites create and delete rows in
whatever database they are given.

## Production build

```bash
node build.mjs                 # typecheck + web + API
NODE_ENV=production PORT=8080 node artifacts/api-server/dist/index.mjs
```

In production the API process also serves the built SPA, so the whole app is one
origin on one port — which is what Clerk's session cookie needs. Set
`APP_PUBLIC_URL` to the real HTTPS origin; the server refuses to start in
production without it.

Do **not** set `BASE_PATH` from a shell on Windows. Git Bash's MSYS layer
rewrites a lone `/` to the Git install path and it gets baked into every asset
URL. `build.mjs` sets it from Node for exactly this reason.

## Outbound email

Estimates, spring letters, and weather notices send through the Gmail API using
this deployment's own Google OAuth client.

1. In Google Cloud Console, on a project for this deployment: enable the Gmail
   API, configure the OAuth consent screen, and create an OAuth client of type
   **Desktop app**.
2. Put its id and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. Run `node scripts/google-oauth-setup.mjs`, sign in as the business Gmail
   account, and paste the printed `GOOGLE_REFRESH_TOKEN` into `.env`.

Publish the OAuth app before relying on it — refresh tokens issued while the app
is in "Testing" status expire after seven days.
