# Build and run the Bison Lawn Care CRM as a single container: the API process
# serves the built SPA, so the whole app is one origin on one port.
#
# Debian-based rather than Alpine because the tree pulls native binaries
# (esbuild, rollup, tailwind oxide, lightningcss) and glibc builds are the
# well-trodden path for all of them.
FROM node:24-slim AS build

RUN corepack enable
WORKDIR /app

# Manifests first so a dependency-only change is the only thing that busts the
# install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/bison-crm/package.json ./artifacts/bison-crm/
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/db/package.json ./lib/db/
COPY lib/e2e/package.json ./lib/e2e/
COPY scripts/package.json ./scripts/

RUN pnpm install --frozen-lockfile

COPY . .

# Vite inlines import.meta.env.VITE_* into the bundle at build time, so these
# have to be present now — a runtime env var would arrive far too late and the
# app would load with an undefined Clerk key.
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_CLERK_PROXY_URL
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PROXY_URL=$VITE_CLERK_PROXY_URL

RUN test -n "$VITE_CLERK_PUBLISHABLE_KEY" || (echo "VITE_CLERK_PUBLISHABLE_KEY build arg is required" && exit 1)
RUN node build.mjs

FROM node:24-slim AS runtime

RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# The API bundle externalises pdfkit (it loads .afm font data through subpath
# imports at runtime) and drizzle-kit is needed for schema pushes, so the whole
# installed tree ships rather than a pruned production set.
COPY --from=build /app /app

# Drop privileges. node:24-slim already provides the `node` user.
RUN chown -R node:node /app
USER node

EXPOSE 8080
ENV PORT=8080

# No HEALTHCHECK curl in slim; use node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
