# Runbook — deploying alongside the live `takeoff` stack

Written against the actual host as inspected 2026-08-26.

## What is already running

| | |
|---|---|
| `takeoff-caddy-1` | `caddy:2-alpine`, owns 80/443/2019, network `takeoff_default` (aliases `takeoff-caddy-1`, `caddy`) |
| `takeoff-app-1` | `8100/tcp`, **not** published — reached only through Caddy |
| Caddyfile | **bind mount, read-only**: host `/home/deploy/takeoff/Caddyfile` → `/etc/caddy/Caddyfile` |
| Certificates | volume `takeoff_caddy-data` → `/data` |
| Serving | `workoptional.studio`, live to ~20 clients |

## The safety properties this relies on

1. **The Caddyfile is a host file.** It can be copied, diffed, and restored
   without touching the container. It is mounted read-only, so Caddy cannot
   rewrite it.
2. **`caddy reload` is atomic and zero-downtime.** If the new config fails to
   load, Caddy keeps serving the *old* config and returns a non-zero exit. A bad
   edit therefore cannot take `workoptional.studio` down — it simply does not
   apply. This is why every step below uses `reload`, never `restart`.
3. **Adding a vhost adds a certificate**; it does not touch existing ones in
   `takeoff_caddy-data`.
4. **`.studio` and `.tech` are separate DNS zones.** No routing or cert overlap.

## Rules

- Never `docker compose down`, `restart`, or `up` in `/home/deploy/takeoff`.
- Never edit the `takeoff` site block. Only append a new one.
- Always `validate` before `reload`.

---

## 1. Back up the Caddyfile

```bash
sudo cp /home/deploy/takeoff/Caddyfile /home/deploy/takeoff/Caddyfile.bak.$(date +%F-%H%M)
ls -l /home/deploy/takeoff/Caddyfile*
```

Do not skip this. It is the entire rollback plan for step 5.

## 2. DNS

A record `bisonlawn.workoptional.tech` → this host's IP. Confirm it resolves
*before* touching Caddy — Caddy tries to issue a certificate the moment the
vhost loads, and repeated failures put it in a backoff.

```bash
dig +short bisonlawn.workoptional.tech
```

## 3. Shared network

A dedicated network, **not** `takeoff_default`. Attaching this app to
`takeoff_default` would make a future `docker compose down` in the takeoff
project fail with "network in use".

```bash
docker network create web-proxy
docker network connect web-proxy takeoff-caddy-1
```

`network connect` attaches a running container live — **no restart, no
downtime**. Confirm Caddy is now on both, and that takeoff_default is unchanged:

```bash
docker inspect takeoff-caddy-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# expect: takeoff_default web-proxy
curl -sI https://workoptional.studio | head -1     # takeoff still serving
```

If anything looks wrong: `docker network disconnect web-proxy takeoff-caddy-1`.

## 4. Bring up this stack

Nothing here touches Caddy or takeoff. The app publishes no host port.

```bash
git clone https://github.com/AtlasSolutions100/Bison-Lawn.git bisonlawn
cd bisonlawn
cp .env.deploy.example .env.deploy
nano .env.deploy          # PROXY_NETWORK=web-proxy
docker compose --env-file .env.deploy \
  -f docker-compose.yml -f docker-compose.proxy.yml up -d --build
```

**Build load:** this compiles TypeScript and runs a Vite build — a few minutes of
high CPU on a shared box. It does not touch takeoff's containers, but it does
compete for CPU. If clients are actively demoing, wait for a quiet window.

Create the schema, once:

```bash
docker compose --env-file .env.deploy -f docker-compose.yml -f docker-compose.proxy.yml \
  exec app pnpm --filter @workspace/db run push
```

Verify the app is healthy *before* involving Caddy:

```bash
docker exec bisonlawn-app node -e "fetch('http://127.0.0.1:8080/api/healthz').then(r=>r.text()).then(console.log)"
# expect: {"status":"ok"}
docker exec takeoff-caddy-1 wget -qO- http://bisonlawn-app:8080/api/healthz
# expect: {"status":"ok"}  -- proves Caddy can reach it by name
```

If that second command fails, stop. Do not edit the Caddyfile — the routing is
not ready and a vhost pointing at an unreachable upstream just adds noise.

## 5. Add the vhost

Append to `/home/deploy/takeoff/Caddyfile` — **append, never replace**:

```
bisonlawn.workoptional.tech {
	reverse_proxy bisonlawn-app:8080
	encode gzip zstd
	request_body {
		max_size 25MB
	}
	log {
		output stdout
		format json
	}
}
```

Validate, then reload:

```bash
docker exec takeoff-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# only if that exits 0:
docker exec takeoff-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

A failed `reload` leaves the previous config running — takeoff keeps serving.

**Rollback**, if anything is off:

```bash
sudo cp /home/deploy/takeoff/Caddyfile.bak.<stamp> /home/deploy/takeoff/Caddyfile
docker exec takeoff-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

## 6. Check both sites

```bash
curl -sI https://workoptional.studio | head -1                    # takeoff: unchanged
curl -s  https://bisonlawn.workoptional.tech/api/healthz          # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://bisonlawn.workoptional.tech/dispatch   # 200
```

Check takeoff first, every time. Then sign in to the CRM in a browser.

## Undoing the whole thing

```bash
cd ~/bisonlawn && docker compose --env-file .env.deploy \
  -f docker-compose.yml -f docker-compose.proxy.yml down -v
sudo cp /home/deploy/takeoff/Caddyfile.bak.<stamp> /home/deploy/takeoff/Caddyfile
docker exec takeoff-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
docker network disconnect web-proxy takeoff-caddy-1
docker network rm web-proxy
```

Leaves the host exactly as it was found.

## Known fragility, and which way it points

If the takeoff stack is ever recreated (`docker compose up -d` in
`/home/deploy/takeoff`), Compose may drop the manually added `web-proxy` network
from the Caddy container. **bisonlawn then 502s; takeoff is unaffected.** Fix:

```bash
docker network connect web-proxy takeoff-caddy-1
```

This is deliberately the way round it is: the fragility lands on the new app,
never on the live one.
