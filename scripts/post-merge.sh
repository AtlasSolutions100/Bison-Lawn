#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Typecheck the MERGED result. Each task agent typechecks its own branch in
# isolation, so two individually-correct branches can still combine into a
# broken tree (duplicate imports, dropped symbols). This is the only place
# the combination is ever checked.
pnpm run typecheck
