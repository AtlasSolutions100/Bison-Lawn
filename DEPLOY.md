# Deploying to a VPS

One Docker Compose stack per client, behind a reverse proxy that terminates TLS.
The app container binds `127.0.0.1` only, so the proxy is the only route in.

## Before you start

Check the box can take another stack:

```bash
free -m                                   # this stack idles around 400-600 MB
df -h /                                   # the image is ~1.6 GB, plus the DB
docker ps --format '{{.Names}}\t{{.Ports}}'
ss -tlnp | grep -E ':(80|443|8080) '      # who owns 80/443, and is 8080 free
```

If something already owns 80/443, do **not** start a second thing that wants
them — proxy this app from whatever is already there (see *Existing proxy*).

## 1. Get the code and the secrets onto the server

```bash
git clone https://github.com/AtlasSolutions100/Bison-Lawn.git bison
cd bison
cp .env.deploy.example .env.deploy
$EDITOR .env.deploy          # every blank must be filled
```

`POSTGRES_PASSWORD` is not something to look up — it is a brand new database in
a brand new container, so you are choosing it. Generate one:

```bash
openssl rand -hex 32
```

**Use hex, not base64.** `openssl rand -base64` emits `/` and `+`, and a `/` in
the password breaks `DATABASE_URL`: `postgres://bison:/abc...@db:5432/x` parses
the host as `bison` and every query fails with `getaddrinfo EAI_AGAIN bison`.
The container still reports healthy, because `/api/healthz` does not touch the
database — so this failure hides behind a green healthcheck.

If port 8080 is taken on this host, set `APP_HOST_PORT` to something free and
match it in the proxy config.

## 2. Point DNS at the box

An `A` record for `bisonlawncare.workoptional.tech` → the VPS IP. Do this *before*
starting Caddy, or certificate issuance fails and Caddy backs off for a while.

## 3. Build and start

```bash
docker compose --env-file .env.deploy up -d --build
```

`--env-file` is required, not optional: `VITE_CLERK_PUBLISHABLE_KEY` is a
**build argument**. Vite inlines `import.meta.env.VITE_*` into the JS bundle, so
it has to exist at build time — supplying it only at runtime produces an app
that loads with an undefined Clerk key and never signs anyone in.

## 4. Create the database schema

The project has no migration files; `drizzle-kit push` is the only mechanism.
Run it explicitly, once, after the first start:

```bash
docker compose --env-file .env.deploy exec app pnpm --filter @workspace/db run push
```

**Do not wire this into container startup.** `push` diffs the schema against the
database and will happily drop a column to make them match. Running it by hand
on each deploy, after reading what it says it will do, is the safeguard until
real migration files exist.

Optional demo data (safe to skip on a real account):

```bash
docker compose --env-file .env.deploy exec app pnpm dlx tsx artifacts/api-server/src/seed.ts
```

## 5. Reverse proxy

### Fresh box, no proxy yet

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile   # edit the hostname
sudo systemctl reload caddy
```

### Existing proxy running as a Docker container

If `ss -tlnp | grep -E ':(80|443) '` shows **docker-proxy**, a container already
owns those ports. Find out which, and what network it is on:

```bash
docker ps --format '{{.Names}}	{{.Image}}	{{.Ports}}'
docker inspect <proxy-container> --format '{{json .NetworkSettings.Networks}}'
```

**If it is a reverse proxy** (Caddy, Traefik, nginx-proxy, Nginx Proxy Manager),
use the overlay — the app then publishes no host port at all and the proxy
reaches it by container name over a shared network:

```bash
# .env.deploy: PROXY_NETWORK=<the proxy container's network>
docker compose --env-file .env.deploy   -f docker-compose.yml -f docker-compose.proxy.yml up -d --build
```

Then point the proxy at `http://bisonlawn-app:8080`:

- Traefik — uncomment the labels in `docker-compose.proxy.yml`.
- Caddy (containerised) — add the block from `deploy/Caddyfile.example` to its
  Caddyfile, changing `reverse_proxy 127.0.0.1:8080` to `reverse_proxy bisonlawn-app:8080`.
- Nginx Proxy Manager — add a Proxy Host: `bisonlawncare.workoptional.tech` →
  forward to `bisonlawn-app` port `8080`, with "Websockets" on and an SSL cert
  requested. Make sure NPM is on the same network as `PROXY_NETWORK`.

**If it is the application itself** publishing 80/443 directly, a proxy has to be
introduced in front of both apps, which means rebinding that app's ports. Do that
deliberately, not during a deadline — it takes the existing site down briefly.

### Existing proxy installed on the host

Caddy — append the block from `deploy/Caddyfile.example` to the existing
Caddyfile and `caddy reload`.

nginx — add a server block and issue a cert with certbot:

```nginx
server {
    server_name bisonlawncare.workoptional.tech;
    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        client_max_body_size 25M;
    }
}
```

`X-Forwarded-Host` and `X-Forwarded-Proto` are load-bearing, not boilerplate:
the Clerk proxy middleware builds its `Clerk-Proxy-Url` from them.

## 6. Check it

```bash
curl -s https://bisonlawncare.workoptional.tech/api/healthz     # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://bisonlawncare.workoptional.tech/dispatch   # 200, not 404
docker compose --env-file .env.deploy logs -f app
```

Then sign in in a browser. An account whose **verified** email matches
`APP_OWNER_EMAIL` or `APP_SECONDARY_OWNER_EMAIL` lands on the admin dashboard.
Anyone else lands on the contractor job board until an owner promotes them from
**Team**.

## Updating

```bash
git pull
docker compose --env-file .env.deploy up -d --build
```

Re-run the schema push only when `lib/db/src/schema/` changed, and read its
output before confirming.

## Backups

Nothing backs the database up automatically. Add a cron entry:

```bash
0 3 * * * docker compose -f /path/to/bison/docker-compose.yml --env-file /path/to/bison/.env.deploy \
  exec -T db pg_dump -U bison bisonlawn | gzip > /backups/bison-$(date +\%F).sql.gz
```

Then actually restore one somewhere before you rely on it.

## Adding the next client

Copy the repo to a new directory, then change in `docker-compose.yml`: the
volume name (`bison-db`), the Postgres database and user, and `APP_HOST_PORT`.
Give it its own `.env.deploy` and its own subdomain block in the proxy. Nothing
is shared between clients — separate database, separate container, separate
Clerk application.

## Known rough edges

- **Image is ~1.6 GB.** The whole installed tree ships because the API bundle
  externalises pdfkit and schema pushes need drizzle-kit. Slimmable later; it is
  not worth the risk of a broken deploy tonight.
- **Clerk development keys** work on a custom domain but carry Clerk's dev banner
  and strict usage limits. Moving to a Clerk production instance means new keys
  and setting `VITE_CLERK_PROXY_URL` — do not set that with dev keys.
- **`drizzle-kit push` is not a migration system.** Replace it before the data
  matters.

## Switching QuickBooks from sandbox to production

Do these in order. The order is not cosmetic.

**1. Disconnect the sandbox grant while the development keys are still in place.**
Use the Disconnect button on /books. The revoke call is signed with whatever
client credentials the server currently holds, so swapping keys first leaves the
sandbox grant alive on Intuit's side with nothing pointing at it. Confirm the
table is empty afterwards:

```
docker exec <db-container> psql -U bison -d <db> -t -A -c 'select count(*) from quickbooks_connection;'
```

**2. Register the redirect URI on the PRODUCTION key set.**
Intuit keeps separate redirect-URI lists for Development and Production keys.
Configuring the sandbox one does not configure the other, and the failure only
appears when someone clicks Connect. On the Intuit developer dashboard, open the
app, switch to the **Production** keys tab, and add exactly:

```
https://<client-host>/api/quickbooks/callback
```

No trailing slash. It must match what `resolveRedirectUri()` produces, which is
`APP_PUBLIC_URL` + `/api/quickbooks/callback` unless `INTUIT_REDIRECT_URI`
overrides it.

**3. Check the app's display name on the dashboard.** Whatever it is called is
what the client sees when asked to approve access to their real books. "Test App
wants to access your QuickBooks data" is not what you want in front of a paying
customer.

**4. Install the production credentials.** Pipe them over stdin rather than
putting them in a command line, so they stay out of shell history and process
lists:

```
grep -E '^INTUIT_CLIENT_ID=|^INTUIT_CLIENT_SECRET=' .env | tr -d '\r' | ssh <host> '
umask 077
cat > /tmp/intuit.new
cd /root/<project>
cp .env.deploy .env.deploy.bak-$(date +%s)
grep -v -E "^INTUIT_CLIENT_ID=|^INTUIT_CLIENT_SECRET=|^INTUIT_ENVIRONMENT=" .env.deploy > /tmp/env.new
cat /tmp/intuit.new >> /tmp/env.new
echo "INTUIT_ENVIRONMENT=production" >> /tmp/env.new
mv /tmp/env.new .env.deploy
chmod 600 .env.deploy
rm -f /tmp/intuit.new'
```

**5. Recreate the container.** `docker compose restart` does NOT re-read
`env_file` — the old values survive and everything looks fine until the first
Intuit call fails. Use `up -d`, and pass both compose files so the proxy network
config is not dropped:

```
docker compose --env-file .env.deploy -f docker-compose.yml -f docker-compose.proxy.yml up -d app
docker exec <app-container> printenv INTUIT_ENVIRONMENT
```

**6. Pre-flight before handing it to the client.** Load /books and click Connect
yourself. Stop at Intuit's screen — do not authorize. You are checking that
Intuit accepts the client id and the redirect URI. If either is wrong you get
`appcenter.intuit.com/app/connect/oauth2/error`, and "View error details (for
Developers)" names which one. Finding that yourself takes a minute; finding it
because the client hit it costs a support call and their confidence.

### Why a leftover sandbox row is not dangerous

`/api/quickbooks/status` reports `connection?.environment ?? intuitEnvironment()`,
so the "these are not your real books" banner follows the grant, not the server
setting. A stale sandbox connection keeps its banner even after the server is
switched to production. Sandbox figures cannot silently render as real books.
