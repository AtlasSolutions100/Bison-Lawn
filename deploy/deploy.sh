#!/usr/bin/env bash
#
# Pull the current main and rebuild this client's stack. Run on the server:
#
#   /root/bisonlawn/deploy/deploy.sh
#
# Deliberately touches only this compose project. The takeoff stack shares the
# host and owns ports 80/443 through its own Caddy; nothing here goes near it.
#
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/bisonlawn}"
APP_CONTAINER="${APP_CONTAINER:-bisonlawn-app}"
HEALTH_URL="${HEALTH_URL:-https://bisonlawncare.workoptional.tech/api/healthz}"
COMPOSE=(docker compose --env-file .env.deploy -f docker-compose.yml -f docker-compose.proxy.yml)

cd "$PROJECT_DIR"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# --------------------------------------------------------------- preflight ---
[ -f .env.deploy ] || die ".env.deploy is missing. Without it compose cannot
  interpolate VITE_CLERK_PUBLISHABLE_KEY and the build stops before it starts."

# A dirty tree means someone edited on the server, or shipped by scp. Pulling
# over it either conflicts or silently discards their work, so stop and let a
# human decide. --force resets to origin and throws local edits away.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  if [ "${1:-}" = "--force" ]; then
    say "Working tree is dirty; --force given, resetting to origin/main"
    git fetch origin
    git reset --hard origin/main
  else
    say "Working tree has local modifications:"
    git status --short --untracked-files=no
    die "Refusing to deploy over local edits. Commit and push them, or re-run
  with --force to discard them and take origin/main as-is."
  fi
fi

BEFORE="$(git rev-parse --short HEAD)"

# ------------------------------------------------------------------- fetch ---
say "Fetching origin"
git fetch origin || die "Could not reach GitHub. The deploy key lives at
  /root/.ssh/github_bisonlawn and is selected by the Host github.com stanza in
  /root/.ssh/config — check that file exists before suspecting the key."

say "Fast-forwarding to origin/main"
git merge --ff-only origin/main || die "Cannot fast-forward. The server has
  commits that are not on origin, so resolve that by hand rather than here."

AFTER="$(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  say "Already at $AFTER — rebuilding anyway so env-file changes take effect"
else
  say "Updating $BEFORE -> $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'
fi

# ------------------------------------------------------------------- build ---
# --build because the web bundle bakes VITE_* values at build time; a plain
# `up -d` would recreate the container around a stale bundle. `restart` is worse
# still: it re-reads neither the image nor env_file.
say "Building and recreating the app container"
"${COMPOSE[@]}" up -d --build app || die "Build failed. The previous container
  is still serving traffic — nothing was torn down."

# ------------------------------------------------------------------ verify ---
say "Waiting for the container to report healthy"
for i in $(seq 1 30); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null || echo missing)"
  [ "$state" = "healthy" ] && break
  [ "$i" = "30" ] && die "Container never became healthy (last state: $state).
  Check: docker logs $APP_CONTAINER --tail 50"
  sleep 2
done
echo "    container healthy"

# Health through the public hostname, not the container: this also proves Caddy
# is still routing this vhost, which a container check cannot tell you.
say "Checking the public health endpoint"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$HEALTH_URL" || echo 000)"
[ "$code" = "200" ] || die "Health endpoint returned $code. The container is up,
  so suspect Caddy routing before suspecting the app."
echo "    $HEALTH_URL -> 200"

# The neighbour stack shares this host. Say plainly that it was untouched.
say "Confirming the takeoff stack is undisturbed"
docker ps --format '    {{.Names}}  {{.Status}}' | grep -E 'takeoff|bisonlawn' || true

say "Deployed $AFTER"
