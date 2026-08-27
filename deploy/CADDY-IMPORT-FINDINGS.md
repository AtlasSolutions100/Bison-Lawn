# Caddy `import conf.d` — measured behaviour

Answering "does `import` with an empty directory break Caddy?" and the three
follow-ups that determine whether this design is safe for a live site.

Method: `caddy:2-alpine` (same image as `takeoff-caddy-1`), a Caddyfile shaped
like the real one (`{$SITE_HOST}` site block + a trailing
`import /etc/caddy/conf.d/*.caddy`), run under `docker run --rm`.

| # | Scenario | Command | Result |
|---|---|---|---|
| 1 | `conf.d` mounted, **empty** | `caddy validate` | **Valid configuration**, exit 0 |
| 2 | `conf.d` **not mounted at all** | `caddy validate` | **Valid configuration**, exit 0 |
| 3 | One valid site file present | `caddy validate` | **Valid configuration**, exit 0 |
| 4 | One **invalid** site file present | `caddy validate` | **Error**, exit 1 |
| 5 | One **invalid** site file present | `caddy run` | **Error**, exit 1 — process does not start |

## What this means

**The `import` line is safe to ship on its own.** Tests 1 and 2 — a glob that
matches nothing is not an error, and neither is a directory that does not exist.
So the `import` line can go into the Caddyfile and be deployed before
`~/caddy-sites` has anything in it, or ever. No ordering constraint, no window
where takeoff is at risk from the import line itself.

**A broken dropped-in file is contained on reload but NOT on restart.** This is
the one that needs an operating rule:

- Test 4: `caddy reload` with an invalid file **fails atomically**. The previously
  loaded config keeps serving. takeoff is unaffected. This is the good case.
- Test 5: `caddy run` with an invalid file **refuses to start**. So if the Caddy
  container is ever restarted while an invalid file sits in `conf.d` — host
  reboot, docker daemon restart, OOM kill, `docker compose up` — **Caddy does not
  come back, and takeoff goes down with it.**

The failure is deferred and silent: drop a bad file, reload fails, everything
looks fine because the old config is still serving — and the site dies at the
next unrelated restart, with no obvious connection to the change.

## Operating rule this implies

**Never leave an invalid file in `conf.d`.** Validate immediately after writing
one, and if validation fails, delete the file before doing anything else:

```bash
docker exec takeoff-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  || rm ~/caddy-sites/<the-file>.caddy
```

Validation errors name the file and line and print the import chain, e.g.:

```
Error: adapting config using caddyfile: unexpected EOF, at /etc/caddy/conf.d/bisonlawn.caddy:3
  import chain ['/etc/caddy/Caddyfile:10 (import)']
```

so the offending file is unambiguous.

## Worth considering

A restart-time guard is cheap insurance: have the takeoff deploy run
`caddy validate` before it restarts anything, and refuse to restart if it fails.
That converts "takeoff is down and nobody knows why" into "the deploy stopped
and told you which file is broken".
