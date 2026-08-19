# Bison Lawn Care CRM

Custom CRM + job management for Bison Lawn Care LLC — leads/clients, equation-based pricing, estimates, waiting list, dispatch board, invoices/payments, tickets, and a mobile contractor job board with route optimization.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/bison-crm run dev` — run the web app (Vite)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm dlx tsx artifacts/api-server/src/seed.ts` — idempotent dev seed
- Required env: `DATABASE_URL`; Clerk keys auto-provisioned (`CLERK_*`, `VITE_CLERK_PUBLISHABLE_KEY`); `APP_OWNER_EMAIL` securely identifies the business owner account that must always have admin access

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Clerk auth (`@clerk/express`, proxy middleware)
- Web: React + Vite + Tailwind v4 + shadcn, wouter, TanStack Query (generated hooks)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod v4 (catalog pin), `drizzle-zod`
- API codegen: Orval v8 (from `lib/api-spec/openapi.yaml`)

## Where things live

- API contract (source of truth): `lib/api-spec/openapi.yaml` → generated hooks in `lib/api-client-react/src/generated/`, Zod in `lib/api-zod/src/generated/`
- DB schema: `lib/db/src/schema/crm.ts`
- API routes: `artifacts/api-server/src/routes/` (users, clients, services, estimates, jobs, billing, tickets, dashboard)
- Auth: `artifacts/api-server/src/middlewares/requireAuth.ts` (Clerk session → JIT-provisioned local user; first user becomes admin)
- Business logic helpers: `artifacts/api-server/src/lib/helpers.ts` (pricing engine, balance recalc, route optimizer)
- Frontend pages: `artifacts/bison-crm/src/pages/`; theme in `src/index.css`

## Architecture decisions

- Single web artifact serves both admin (sidebar shell) and contractor (mobile bottom-nav) views; role from `/api/me`.
- Roles live in a local `users` table keyed by Clerk user id; the account matching `APP_OWNER_EMAIL` is always promoted to admin, otherwise first signup = admin and later signups = contractor (changeable in /team).
- Pricing engine: services store `pricingEquations` JSONB (base price for first N sqft + increment per M sqft, breakpoints by `upToSqft`).
- Jobs table doubles as waiting list (`dispatched=false`, window dates) and dispatch board (`dispatched=true`, scheduledDate).
- Completing a job auto-creates an invoice (job amount + products); balances always recomputed from invoices − payments.
- Contractor route: server-side nearest-neighbor + 2-opt over client lat/lng from the contractor's home base; Google Maps links for navigation (no API key).

## Product

- Admin: dashboard, clients (notes, property data, lazy audit trail), services & packages with live price calculator, estimates (custom fields, print-to-PDF, send), waiting list with multi-dispatch, dispatch board with 14 columns + filters, invoices/payments (check/Venmo/Zelle/card/cash + reference #), tickets, team management.
- Contractor: mobile job list with one-tap status updates and optimized route view.

## Gotchas

- Never edit generated files; change `openapi.yaml` then run codegen, and run `pnpm -w run typecheck:libs` before typechecking apps (project references).
- Orval v8 emits zod v4 code (`zod.int()`); the workspace catalog must stay on zod ^4.
- Server routes mount under `/api`; frontend must use generated hooks (base path handled by custom-fetch). Web auth is cookie-based — no bearer tokens in browser code.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
