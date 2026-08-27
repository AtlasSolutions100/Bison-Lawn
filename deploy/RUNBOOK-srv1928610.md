# Runbook — deploying alongside the live `takeoff` stack

Written against the actual host as inspected 2026-08-26.
Hostname: bisonlawncare.workoptional.tech. DNS: live, resolves to 31.220.50.13.

## What is already running

| | |
|---|---|
| `takeoff-caddy-1` | `caddy:2-alpine`, owns 80/443/2019, network `takeoff_default` (aliases `takeoff-caddy-1`, `caddy`) |
| `takeoff-app-1` | `8100/tcp`, **not** published — reached only through Caddy |
| Caddyfile | **bind mount, read-only**: host `/home/deploy/takeoff/Caddyfile` → `/etc/caddy/Caddyfile` |
| Certificates | volume `takeoff_caddy-data` → `/data` |
| Serving | `workoptional.studio`, live to ~20 clients |
| Caddyfile shape | one site block, addressed by the **env placeholder `{$SITE_HOST}`**; no global options block; upstream is the alias `app:8100` |

## The safety properties this relies on

1. **This runbook never edits the takeoff Caddyfile.** Vhosts are dropped into
   `~/takeoff/caddy-sites`, which the takeoff deploy does not overwrite. (The Caddyfile
   itself is `scp`'d over on every takeoff deploy, so editing it would be
   guaranteed to be lost — that is why the drop-in directory exists.)
2. **`caddy reload` is atomic and zero-downtime.** If the new config fails to
   load, Caddy keeps serving the *old* config and returns a non-zero exit. A bad
   edit therefore cannot take `workoptional.studio` down — it simply does not
   apply. This is why every step below uses `reload`, never `restart`.
3. **Adding a vhost adds a certificate**; it does not touch existing ones in
   `takeoff_caddy-data`.
4. **An `import` glob that matches nothing is not an error** — measured, see
   `CADDY-IMPORT-FINDINGS.md`. The wiring is inert until a file is dropped in.
5. **`.studio` and `.tech` are separate DNS zones.** No routing or cert overlap.

## Rules

- Never `docker compose down`, `restart`, or `up` in `/home/deploy/takeoff`.
- Never edit `/home/deploy/takeoff/Caddyfile`. Every takeoff deploy `scp`s it
  over from its own repo; edits there are guaranteed to be lost.
- Never leave an invalid file in `~/takeoff/caddy-sites`.
- Always `validate` before `reload`.

---

## 1. Confirm the drop-in directory exists

Nothing in this runbook edits `/home/deploy/takeoff/Caddyfile`, so there is
nothing to back up. Instead, confirm the takeoff side has shipped the `import`
line and the mounted directory:

Done on the takeoff side as of 2026-08-26. Confirm rather than assume:

```bash
tail -3 /home/deploy/takeoff/Caddyfile          # expect: import /etc/caddy/conf.d/*.caddy
ls -ld ~/takeoff/caddy-sites
docker exec takeoff-caddy-1 ls /etc/caddy/conf.d
docker network ls | grep web-proxy
```

The directory is mounted **read-only into the container** — that only stops Caddy
from writing it. Writing to the host path `~/takeoff/caddy-sites/` is normal, and
the takeoff deploy excludes that directory, so files there survive releases.

If any of those are missing, stop — there is no safe place to put a vhost.

## 2. DNS

A record for bisonlawncare.workoptional.tech → **31.220.50.13**.
(`workoptional.tech` itself points at 2.57.91.91 and is hosted elsewhere — only
the subdomain comes here.) Confirm it resolves
*before* touching Caddy — Caddy tries to issue a certificate the moment the
vhost loads, and repeated failures put it in a backoff.

```bash
dig +short bisonlawncare.workoptional.tech    # must return 31.220.50.13
```

## 3. Shared network

The `web-proxy` network is declared as an **external network on the Caddy service
in the takeoff repo's `docker-compose.yml`**, so the attachment is version
controlled and survives every deploy and container recreate. That work is owned
by the takeoff side — do not `docker network connect` by hand, which is exactly
the fragility that arrangement removes.

Confirm it exists and Caddy is on it before going further:

```bash
docker network ls | grep web-proxy
docker inspect takeoff-caddy-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# expect: takeoff_default web-proxy
```

If the network does not exist yet, `docker network create web-proxy` — Compose
will not create a network marked `external`. Creating it is harmless and
idempotent in effect; attaching Caddy to it is the takeoff side's job.

Sanity-check the live site is still fine before continuing:

```bash
curl -sI https://workoptional.studio | head -1
```

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

The takeoff Caddyfile now ends with `import /etc/caddy/conf.d/*.caddy`, backed by
a mounted `~/takeoff/caddy-sites` directory that the takeoff deploy never overwrites.
**Do not edit `/home/deploy/takeoff/Caddyfile`** — every takeoff deploy `scp`s
that file over from its own repo, so any edit there is guaranteed to be lost.

### 5a. Drop the file in

```bash
cat > ~/takeoff/caddy-sites/bisonlawncare.caddy <<'CADDY'
bisonlawncare.workoptional.tech {
	encode zstd gzip

	reverse_proxy bisonlawn-app:8080

	request_body {
		max_size 25MB
	}

	log {
		output stdout
		format console
	}
}
CADDY
```

`format console` matches the takeoff block on purpose: both write into the same
`docker logs takeoff-caddy-1` stream, and mixing console with json would make
that stream harder to read during an incident.

### 5b. Validate — and delete the file if it fails

This step is not optional, and the `||` is the important half. See
`CADDY-IMPORT-FINDINGS.md`: an invalid file in `conf.d` makes `caddy reload`
fail harmlessly (the old config keeps serving), but it makes `caddy run`
**refuse to start**. So a bad file left in place does nothing visible now and
takes takeoff down at the next unrelated restart — a host reboot, a docker
daemon restart, an OOM kill.

```bash
docker exec takeoff-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || rm ~/takeoff/caddy-sites/bisonlawncare.caddy
```

Never walk away from a failed validate with the file still there.

### 5c. Reload

```bash
docker exec takeoff-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

A failed reload leaves the previous config running — takeoff keeps serving.

## 6. Check both sites

```bash
curl -sI https://workoptional.studio | head -1                    # takeoff: unchanged
curl -s  https://bisonlawncare.workoptional.tech/api/healthz          # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://bisonlawncare.workoptional.tech/dispatch   # 200
```

Check takeoff first, every time. Then sign in to the CRM in a browser.

## Undoing the whole thing

```bash
rm -f ~/takeoff/caddy-sites/bisonlawncare.caddy
docker exec takeoff-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec takeoff-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
cd ~/bisonlawn && docker compose --env-file .env.deploy   -f docker-compose.yml -f docker-compose.proxy.yml down -v
```

Leaves the host as found. The `web-proxy` network and the `import` line stay —
they are takeoff-side infrastructure now, and both are inert with nothing in
`conf.d` (measured: see `CADDY-IMPORT-FINDINGS.md`, tests 1 and 2).

## Residual risk

With the vhost in `~/takeoff/caddy-sites` and the network declared in takeoff's compose,
the two fragilities in the earlier version of this runbook are gone: nothing here
survives only as an untracked manual change.

What remains: a broken file in `~/takeoff/caddy-sites` prevents Caddy from starting, so
it would take takeoff down at the next restart rather than at the moment of the
mistake. Step 5b's `|| rm` is the guard. A `caddy validate` gate in the takeoff
deploy, before it restarts anything, would make that guard belt-and-braces.
