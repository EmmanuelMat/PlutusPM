# Frontend ↔ Backend GraphQL Integration Plan — Secure by OWASP Top 10

**Status:** Planning → Execution (Branch: `feat/graphql-frontend-integration-secure` in backend, `feat/graphql-backend-integration-secure` in frontend)
**Date:** 2025-07-16
**Goal:** Make `PlutusPM_dashboard` (Next.js 16) get **all data** from `PlutusPM_api` (Supabase Postgres + pg_graphql) using **GraphQL best practices** and **OWASP Top 10** security

---

## 1. Context & Current State

**Backend (`PlutusPM_api`):**
- 16 migrations, 11 Edge Functions, 7 Buckets, 10 Crons, 6 schemas (platform, portfolio, ops, tenant, visitor, vendor, metrics), 94% capability coverage
- GraphQL via `pg_graphql` at `/graphql/v1` (native, RLS-enforced, custom mutations like `createOrganization`, `createWorkOrder`, `registerVisitor`, `evaluateVendorCompliance`, `getSiteKpis`)
- REST via PostgREST at `/rest/v1/` with `Accept-Profile` header for custom schemas
- Fixed: extra_search_path includes custom schemas, SELECT grants for anon+authenticated, introspection enabled per schema in 00017, nested $$ fixed, geography type fixed, USAGE privilege fixed
- Auth: Supabase Auth GoTrue, JWT ES256, refresh token rotation, HttpOnly cookies pattern in frontend
- Types: `types/database.ts` full DB types, Postman GraphQL collection 60+ requests

**Frontend (`PlutusPM_dashboard`):**
- Next.js 16.2.10, React 19, Tailwind 4, Base UI, React Aria, Recharts, no `@supabase/supabase-js`, custom `graphqlRequest` + `restRequest` clients using `NEXT_PUBLIC_SUPABASE_URL`, `GRAPHQL_ENDPOINT`, `REST_ENDPOINT`, `ANON_KEY`
- Route groups: `(dashboard)` management portal (work-orders, assets, inspections, vendors, visitors, service-requests, organizations, users), `(tenant)` tenant portal (amenities, announcements, events, requests, reservations, visitors), `(marketing)` marketing
- Currently: `management-context.ts` fetches memberships/organizations/sites via REST (already wired, 100% compatible), `inspections.ts` fully wired via REST profile `ops`, rest of dashboard pages use **mock** `plutusData` (workOrders, assets, vendors, visitors, dashboard metrics) — **needs wiring**
- Env vars expected: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_GRAPHQL_ENDPOINT`, `NEXT_PUBLIC_REST_ENDPOINT`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Types: `app/_types/plutus.ts` mock types mappable to backend real types

**Problem:** Frontend GraphQL queries were failing with `Unknown field portfolioPortfoliosCollection` because:
- `extra_search_path` missing custom schemas (fixed in 01ce69e)
- SELECT grants missing for anon (fixed in 00016)
- Introspection disabled by default since pg_graphql 1.6.0 (fixed in 00017 with `introspection: true`)
- apikey header empty in user's curl (env var not set)
- Seed skipped because no auth user existed → empty `edges: []` (fixed with force seed SQL)

**Now GraphQL returns data (empty edges) after fixes — ready to wire real data.**

---

## 2. Goals

1. **Replace mock `plutusData` with real GraphQL queries** in all dashboard pages (work-orders, assets, vendors, visitors, dashboard overview, etc) and tenant portal
2. **Follow GraphQL best practices:** typed queries, fragments, pagination, filtering, error handling, caching, codegen, persisted queries
3. **Follow OWASP Top 10 security** for both frontend and backend
4. **Do NOT work in main branches** — create feature branches per repo, document everything, PR later
5. **Document** in both repos: plan, security checklist, env setup, how to run, how to test

---

## 3. OWASP Top 10 (2021) Mapping to Our Stack — Mitigations

### A01: Broken Access Control

**Risk:** Users see other org's sites, work orders, vendors

**Mitigations (Backend Already Has, Frontend Must Enforce):**
- **RLS:** Every table `enable row level security` + policies using `platform.can_access_site(site_id)` / `is_org_member(org_id)` — already in 15 migrations
- **RBAC:** `platform.memberships` role enum 10 values (owner/admin/portfolio_manager/site_manager/building_engineer/security/tenant_admin/tenant_user/vendor/auditor) + `site_ids[]` null=all, `portfolio_ids[]`
- **Helper:** `is_site_manager(site_id)` checks role owner/admin/portfolio_manager/site_manager + site_ids
- **Frontend:** 
  - Never trust client role UI gating only — backend RLS enforces
  - In frontend, `requireManagementContext()` already checks memberships and filters `allowedSiteIds = membership.site_ids ?? sites.map(id)` — keep this
  - For GraphQL, always filter by `siteId` from context, never allow user to query arbitrary siteId without check
  - Use `getScopedPropertyId(requestedId, availableIds)` already in frontend to prevent access to unauthorized property
  - Example secure query: `workOrdersCollection(filter: {siteId: {eq: $siteId}})` where $siteId comes from `context.siteIds`, not from URL user input without validation

**Implementation in Frontend:**
- In each server component, call `requireManagementContext()` first (throws if no session or no membership)
- Use `scopedPropertyId` for filtering
- Never pass raw URL param as site_id without checking against `context.siteIds`

### A02: Cryptographic Failures

**Risk:** Secrets leaked, JWT in localStorage, no HTTPS, anon key exposed? service_role leaked to frontend

**Mitigations:**
- **Backend:** 
  - All secrets in env vars, not in repo (`.env.example` not `.env`), use `env()` substitution in config.toml for OAuth secrets
  - `service_role` key NEVER exposed to frontend — only `anonKey` in frontend env, service_role only in Edge Functions via `SUPABASE_SERVICE_ROLE_KEY` env
  - Passwords hashed via Supabase Auth (GoTrue bcrypt)
  - Storage buckets private by default (100MB site-files private, only avatars public)
  - Signed URLs for private files with 1h/7d expiry, not public URLs
- **Frontend:**
  - Use **HttpOnly Secure SameSite=Lax cookies** for session (already in `auth-cookies.ts` persistAuthSession) — NOT localStorage
  - `NEXT_PUBLIC_` env vars only contain anon key + URLs (public), not service_role
  - All fetch `cache: "no-store"` for auth-sensitive data
  - Use HTTPS in production (Supabase cloud does, Vercel does)
  - Env var validation in `getPublicBackendEnv()` throws if missing

**Implementation:**
- Ensure frontend `.env.local` only has 4 public vars, no service_role
- Ensure `auth-cookies.ts` sets HttpOnly, Secure (in production), SameSite Lax, Path /
- No `localStorage.setItem('supabase.auth.token')` pattern

### A03: Injection (SQL, GraphQL, etc)

**Risk:** GraphQL injection via variables, SQL injection via raw queries

**Mitigations:**
- **Backend:** 
  - pg_graphql uses prepared statements, not string interpolation — safe if using variables
  - All custom functions use `security definer` + `set search_path` + parameterized inputs (p_site_id uuid, p_title text) — no dynamic SQL concatenation except safe cases
  - No `EXECUTE format('SELECT ... %s', user_input)` without proper quoting
  - All inputs validated: p_slug regex `^[a-z0-9-]+$`, enums check, numeric ranges
- **Frontend:**
  - **Never** interpolate user input into GraphQL query string: BAD: ``query { sitesCollection(filter: {name: {eq: "${userInput}"}}) }`` GOOD: Use variables: `query Sites($name: String!) { sitesCollection(filter: {name: {eq: $name}}) }` + variables `{name: userInput}`
  - Use zod for input validation in server actions (e.g., `createInspectionAction` already validates siteId, checklistId, scheduledAt)
  - Use `graphqlRequest` with variables object, not string concatenation

**Implementation:**
- In all new GraphQL queries, use `$variable` syntax + `variables` object
- Add zod schemas for server actions

### A04: Insecure Design

**Risk:** No threat modeling, insecure defaults

**Mitigations:**
- **Domain-Driven:** 6 schemas isolate domains, least privilege
- **Multi-tenant:** Portfolio → Sites → Everything scoped via site_id, RLS mandatory
- **Secure by Default:** RLS enabled on every table, no public tables without RLS, anon has SELECT only via grants but RLS still filters rows
- **Fail Secure:** If can_access_site returns false, query returns empty, not error leaking info

**Implementation:**
- Keep RLS enabled on all new tables
- Default deny: No policy = no access

### A05: Security Misconfiguration

**Risk:** Introspection enabled in prod, verbose errors, CORS *, no rate limiting, default creds

**Mitigations:**
- **Backend:**
  - Introspection: Enabled in dev via `comment on schema ... is '@graphql({"introspection": true})'` in 00017 for development. **In production, disable introspection** by setting comment to `{"introspection": false}` or only enable for specific schemas. Document in plan: dev has introspection true, prod should have false.
  - GraphQL Playground / GraphiQL: Supabase Studio has GraphiQL but production API should not expose playground — Supabase cloud disables playground in prod by default
  - CORS: Supabase config allows all origins for anon key? Should restrict `additional_redirect_urls` to known domains in production (currently allows localhost + 127.0.0.1, need to add prod domain)
  - Rate Limiting: Supabase has 100 req/s per IP for anon, but we should add Edge Function gateway for GraphQL with rate limiting via Upstash Redis or similar for custom limits
  - Error Messages: Backend functions return generic "Access denied" not leaking SQL or stack, but some functions return SQLERRM notice — in production, should not leak SQLERRM to client, log server side only
  - Default Passwords: No default, demo@cre.local password123 only for local dev, not prod
- **Frontend:**
  - Next.js config: `next.config.ts` should have `poweredByHeader: false`, `reactStrictMode: true`
  - Env vars validation throws if missing
  - No console.log of secrets

**Implementation:**
- Create `supabase/config.toml` comment: For production, set introspection false via migration that runs only in prod, or document manual step
- Add Edge Function `graphql-gateway` that does rate limiting (e.g., 60 req/min per IP per user) + logs
- In frontend, ensure error messages shown to user are generic, not raw GraphQL errors with stack

### A06: Vulnerable and Outdated Components

**Risk:** Next.js 16, React 19, Supabase packages outdated with CVEs

**Mitigations:**
- **Backend:** Keep Supabase CLI updated (user had old CLI missing db execute), keep Postgres 15, PostGIS, pg_graphql updated via Supabase cloud auto-updates
- **Frontend:** `package.json` has Next 16.2.10, React 19.2.4 — latest as of mid-2025, good. Need to run `npm audit` / `yarn audit`, enable Dependabot in GitHub repo settings
- Use `npm outdated`, `npm audit fix`

**Implementation:**
- Add GitHub Dependabot config `.github/dependabot.yml` for npm and Docker
- Run `npm audit` in CI

### A07: Identification and Authentication Failures

**Risk:** Brute force, weak passwords, no MFA, session fixation, JWT theft

**Mitigations:**
- **Backend:**
  - Supabase Auth: enable_confirmations false for local dev, true for prod; enable_signup true; JWT expiry 3600 (1h), refresh token rotation true, reuse interval 10s
  - Passwords: Supabase Auth enforces min length, could enable `secure_password_change` (requires reauth)
  - Brute force: Supabase has built-in rate limiting on /auth/v1/token, but could add Edge Function with extra rate limiting + captcha (hCaptcha) for sign-in
  - Session: JWT ES256 asymmetric (new) more secure than HS256, kid header, exp, iat, aud authenticated, etc — we have ES256 JWTs (user's JWT was ES256)
  - Refresh tokens stored in HttpOnly cookies, not localStorage
- **Frontend:**
  - `signInAction` already validates email/password not empty, uses server action (server-only), not client side, persists via HttpOnly cookies
  - `getAuthSession` reads cookies, not localStorage
  - `jwtDecode` uses Buffer, not atob
  - Should add: rate limiting on sign-in page (e.g., 5 attempts per 15min per IP via Upstash), add hCaptcha, add MFA TOTP option via `supabase.auth.mfa`
  - Protect all dashboard routes with `requireManagementContext()` which throws BackendAuthError if no session → redirects to /sign-in

**Implementation:**
- Keep auth as server actions, not client
- Add MFA enrollment page (optional)
- Add rate limiting via Edge Function or Upstash Redis for /sign-in

### A08: Software and Data Integrity Failures

**Risk:** Insecure deserialization, unverified Edge Functions, unsigned storage files, no Subresource Integrity

**Mitigations:**
- **Backend:**
  - Edge Functions: All have `verify_jwt` true except public ones (health, visitor-kiosk, scheduled-reports, compliance-daily-check) — public ones are intentional for kiosk and cron. For those, validate input and don't trust user data
  - Storage: Files uploaded via RLS path org/site/... + signed URLs with expiry, not public permanent URLs (except avatars public)
  - `parse-coi-pdf` Edge: Downloads file from storage via service_role, validates file type, size, does not execute file, regex extraction, not eval
  - `pg_net` http_post to only trusted URLs (Supabase functions URL via host.docker.internal or https://project.supabase.co/functions/v1/...) — no user-controlled URL in cron jobs (fixed)
- **Frontend:**
  - No `eval()`, no `dangerouslySetInnerHTML` with user input
  - Use Next.js built-in font optimization, not external CDN without SRI
  - All npm packages from trusted registry

**Implementation:**
- Ensure Edge Functions that take storage_path validate path starts with org_id/site_id that user can_access_site
- Add file type validation in upload (mime, size)

### A09: Security Logging and Monitoring Failures

**Risk:** No audit logs, no alerts for breaches

**Mitigations:**
- **Backend:**
  - `platform.audit_logs` captures create/update/delete with diff old/new, user_id, org_id, site_id, ip, user_agent via `log_audit()` trigger (generic)
  - `vendor.compliance_audit_logs` tracks compliance status changes
  - `platform.notifications` for SLA breach, COI expiring, visitor arrived, etc
  - `cron.job_run_details` tracks cron success/failure
  - `net._http_response` tracks pg_net HTTP calls
  - Supabase Dashboard → Logs → Postgres, Auth, Storage, Realtime, Edge Functions
  - Edge Functions log via `console.error` and return error JSON (should not leak stack in prod)
- **Frontend:**
  - Log auth failures, GraphQL errors (without sensitive data) via client-side error reporting (e.g., Sentry)
  - Use `ActivityFeed` to show recent activity from audit logs (future: fetch from audit_logs table)

**Implementation:**
- Attach `log_audit()` trigger to all main tables (currently generic function exists but not attached to every table — need to add in migration 00018)
- Add Sentry or similar in frontend for error monitoring
- Add request ID header for tracing

### A10: Server-Side Request Forgery (SSRF)

**Risk:** Edge Functions fetch user-controlled URLs (e.g., parse-coi-pdf storage_path could be manipulated to fetch internal metadata URL)

**Mitigations:**
- **Backend:**
  - `pg_net` http_post in cron jobs only calls trusted Supabase functions URL (hardcoded, not user input)
  - `parse-coi-pdf` downloads from storage via Supabase client with service_role, path validated to start with org_id (user's org), not arbitrary URL
  - `compliance-report`, `scheduled-reports` upload to storage via Supabase client, not arbitrary URL
  - No Edge Function takes arbitrary URL from user input and fetches it without validation
  - If need to fetch external URL (e.g., QR code api.qrserver.com), allowlist only that domain
- **Frontend:**
  - No SSRF via frontend (client-side fetch to Supabase only, not arbitrary backend)
  - Validate all URLs in frontend before fetch

**Implementation:**
- In `parse-coi-pdf`, validate storage_path matches regex `^[0-9a-f-]+/[0-9a-f-]+/...` (org_id/site_id) and user can_access_site
- In `amenity-booking`, `visitor-kiosk`, etc, no external fetch except Supabase

---

## 4. GraphQL Best Practices

### Schema Design (Backend Already Does):

- **6 schemas** domain-driven, not one big public
- **Primary keys required** for pg_graphql (all tables have id uuid PK)
- **inflect_names true** for camelCase (portfoliosCollection, sitesCollection, not portfolio_portfolios_collection)
- **introspection true in dev, false in prod** (configurable per schema via comment)
- **Custom mutations via functions** with `@graphql({"type": "mutation", "name": "createOrganization"})` explicit naming, not auto-generated insertIntoX which is less controlled
- **RLS enforced** — GraphQL respects RLS, no bypass

### Query Design (Frontend Should Do):

- **Use typed queries with variables, not string interpolation** (OWASP A03)
- **Use fragments for reusability**: e.g., `fragment SiteFields on Site { id name city state sqFt }`
- **Use pagination**: `first: 20, after: $cursor` with `pageInfo { hasNextPage endCursor }`
- **Use filtering**: `filter: {siteId: {eq: $siteId}, status: {neq: completed}}`
- **Use ordering**: `orderBy: {createdAt: DescNullsLast}`
- **Avoid over-fetching**: Only request fields needed, not `select *`
- **Avoid N+1**: Use nested collections with filter, not separate queries per row (e.g., `sitesCollection { edges { node { buildingsCollection { edges { node { name } } } } } }` is okay, pg_graphql batches)
- **Use persisted queries in production**: Map query hash to query string, only allow hashes, disable ad-hoc queries
- **Query depth/complexity limiting**: Add Edge Function gateway that checks query depth < 10, complexity < 1000
- **Error handling**: Check `payload.errors`, throw `BackendError`, show generic message to user, log details server-side

### Client (Frontend):

- **Single client**: `graphqlRequest<TData, TVariables>({query, variables, accessToken})` already exists in `app/_lib/backend/graphql/client.ts` — uses fetch, apikey header, Authorization Bearer, cache no-store, handles 401/403, checks Unknown field → GraphQLSchemaUnavailableError
- **Server Components**: Data fetching in server components (e.g., `app/(dashboard)/dashboard/page.tsx` is server component) — keeps anonKey + JWT server-side, not exposed to client JS bundle (except anonKey is public by design, JWT in HttpOnly cookie)
- **No client-side GraphQL with useEffect** — use server components + server actions for mutations
- **Codegen (Optional but Recommended)**: Use GraphQL Code Generator to generate TypeScript types from GraphQL schema + queries. Add `codegen.yml` that introspects local GraphQL endpoint and generates `app/_lib/graphql/generated.ts` with typed hooks

### Caching:

- Next.js `fetch` with `cache: "no-store"` for real-time data (work orders, visitors) or `next: { revalidate: 60 }` for semi-static (sites, portfolios)
- Could add `revalidatePath` after mutations (already done in inspection-actions.ts)

### Rate Limiting:

- Supabase has 100 req/s per IP for anon key, but GraphQL queries can be expensive (nested collections)
- Add Edge Function `graphql-gateway` that sits in front of `/graphql/v1`, does rate limiting via Upstash Redis (e.g., 60 req/min per userId/IP), logs, checks query depth, and forwards to real GraphQL endpoint

---

## 5. Implementation Plan — Phases (Not in Main)

### Branch Strategy:

- **Backend:** `feat/graphql-frontend-integration-secure` (this branch) — not main
- **Frontend:** `feat/graphql-backend-integration-secure` — not main
- Both branches will be pushed to GitHub, PRs created later, not merged to main directly (as per user request)

### Phase 0: Setup & Types (Done in Planning)

- [x] Backend: 15 migrations, 11 Edge Functions, 7 Buckets, 10 Crons, Types `types/database.ts`, Postman GraphQL collection 60+ requests, docs fixed
- [x] Frontend: Analyzed, compatibility report `docs/FRONTEND_BACKEND_COMPATIBILITY.md` (94% compatible)
- [x] Create feature branches (this branch)

### Phase 1: Backend Hardening for GraphQL Production (This Plan Doc)

**Goal:** Make GraphQL production-ready with OWASP mitigations, not just dev

**Tasks (Backend Branch):**

1. **Migration 00018 - Security Hardening:**
   - Attach `log_audit()` trigger to all main tables (currently only generic function exists, not attached to every table) → Fixes A09 Logging
   - Add `platform.access_requests` table (id, org_id, user_id, email, requested_role, status pending/approved/rejected) + RLS + policies → Fixes missing Access Requests page in frontend nav
   - Add `platform.configurations` table (org_id, key, value jsonb, category, is_secret bool) for typed config vs jsonb scattered → Fixes A05 Security Misconfiguration (centralized config)
   - Add comment on all schemas to disable introspection in production: Create function or env var to toggle introspection true in dev, false in prod → For now, keep true in dev (current 00017 does true), document how to disable in prod via migration that sets false
   - Add rate limiting table `platform.rate_limits` (identifier IP/user_id, count, window) + function `check_rate_limit(identifier, limit, window)` + Edge Function `graphql-gateway` that uses it
   - Ensure anon SELECT grants are only for non-sensitive tables (remove anon SELECT from sensitive like audit_logs, memberships? Currently anon has SELECT on all tables via 00016, which may be too permissive - should restrict anon to only public buckets and maybe sites? But authenticated needs SELECT. Review grants: anon should have minimal SELECT - maybe only organizations, sites, etc? Currently 00016 grants SELECT to anon for all tables including compliance_status, etc which may leak? Should restrict anon to only necessary tables, authenticated gets more. For now, keep anon SELECT for all to make GraphQL work, but document that in prod anon should have minimal)

2. **Edge Function `graphql-gateway` (New):**
   - Entry: `supabase/functions/graphql-gateway/index.ts`
   - Purpose: Rate limiting, query depth/complexity check, logging, optional persisted queries
   - Logic:
     - Reads request body {query, variables}
     - Checks IP from `x-forwarded-for` or `x-real-ip`
     - Checks JWT for user_id
     - Calls `check_rate_limit(ip, 60, 60)` (60 req/min per IP) and `check_rate_limit(user_id, 100, 60)` (100 req/min per user) - uses Upstash Redis or in-memory via Deno KV or Postgres table platform.rate_limits
     - Parses query to check depth (count `{` nesting) < 10 and complexity (count fields) < 1000, reject if too high
     - Logs query + variables + user_id to `platform.audit_logs` or console (without sensitive data)
     - Forwards to real GraphQL endpoint `SUPABASE_URL + "/graphql/v1"` with apikey + Authorization headers
     - Returns response
   - Config in `supabase/config.toml`: `[functions.graphql-gateway] verify_jwt = false` (since it will verify itself? Or true to require JWT) - Actually should be false to allow anon introspection? But for prod, should require JWT for most queries except maybe public
   - This gateway is optional - frontend could call GraphQL directly for MVP, but gateway adds security

3. **Documentation:**
   - Update `docs/FRONTEND_GRAPHQL_INTEGRATION_PLAN.md` (this file) in backend repo
   - Update `README.md` with new env vars for gateway, how to disable introspection in prod
   - Add `docs/SECURITY_OWASP_CHECKLIST.md` with A01-A10 checklist and mitigations implemented

### Phase 2: Frontend - Secure GraphQL Client & Auth Hardening

**Goal:** Make frontend's GraphQL client follow best practices + OWASP

**Tasks (Frontend Branch):**

1. **Env Vars:**
   - Ensure `.env.local` has 4 vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_GRAPHQL_ENDPOINT` (http://127.0.0.1:54321/graphql/v1 local, or https://xxx.supabase.co/graphql/v1 cloud), `NEXT_PUBLIC_REST_ENDPOINT` (http://127.0.0.1:54321/rest/v1), `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - Add `.env.example` with same 4 vars dummy values

2. **GraphQL Client Hardening** (`app/_lib/backend/graphql/client.ts`):
   - Already has apikey + Authorization Bearer, cache no-store, 401/403 handling, Unknown field → GraphQLSchemaUnavailableError
   - Add: Query depth/complexity check client-side (optional), timeout (AbortController 10s), logging without sensitive data, error sanitization (don't show raw SQL or stack to user)
   - Add: Support for persisted queries (optional) - map query hash to query string, send hash only
   - Ensure `graphqlRequest` is `server-only` (already has `"server-only"` import at top, good - keeps secrets server-side)

3. **Auth Hardening:**
   - `auth-cookies.ts` already uses HttpOnly Secure SameSite Lax - verify Secure true in production (process.env.NODE_ENV === 'production' ? true : false)
   - Add rate limiting on sign-in page: Use Upstash Redis or in-memory Map with IP tracking in `signInAction` - 5 attempts per 15min per IP, return error "Too many attempts"
   - Add hCaptcha or similar for sign-in (optional)
   - Add MFA enrollment (optional, via supabase.auth.mfa)
   - Protect all dashboard routes with `requireManagementContext()` (already does, throws BackendAuthError if no session → redirects to /sign-in)

4. **Typed Queries + Codegen (Optional but Best Practice):**
   - Add `graphql-codegen` package: `npm i -D @graphql-codegen/cli @graphql-codegen/typescript @graphql-codegen/typescript-operations`
   - Create `codegen.yml` that introspects local GraphQL endpoint (needs introspection true, which we have in dev via 00017) and generates `app/_lib/graphql/generated.ts` with typed queries
   - Or manually write typed queries with fragments for now (faster)

5. **Create GraphQL Query Files:**
   - Create folder `app/_lib/graphql/queries/` with files: `organizations.ts`, `portfolios.ts`, `sites.ts`, `workOrders.ts`, `assets.ts`, `vendors.ts`, `visitors.ts`, `announcements.ts`, etc
   - Each file exports query string + TypeScript type for variables and data, using fragments
   - Example `sites.ts`:
     ```typescript
     export const SITES_QUERY = `
       query Sites($orgId: UUID!) {
         sitesCollection(filter: {orgId: {eq: $orgId}}, orderBy: {name: AscNullsLast}) {
           edges {
             node {
               id
               name
               slug
               city
               state
               sqFt
             }
           }
         }
       }
     `;
     export type SitesQueryData = { sitesCollection: { edges: { node: { id: string, name: string, city: string | null, state: string | null, sqFt: number | null } }[] } };
     export type SitesQueryVars = { orgId: string };
     ```

### Phase 3: Wire Dashboard Pages from Mock to Real GraphQL

**Goal:** Replace `plutusData` mock with real GraphQL queries in all dashboard pages

**Current State:**
- `app/(dashboard)/dashboard/page.tsx` uses `plutusData` mock for metrics, maintenanceTrend, occupancy, activity, workOrders, assets, vendors, visitors
- `app/(dashboard)/dashboard/work-orders/page.tsx` uses `plutusData.workOrders` mock
- Similar for assets, vendors, visitors, etc
- Only `inspections` page is fully wired via REST (`app/_services/inspections.ts` fetches from `ops.inspections` via REST profile ops) - this is the pattern to copy

**Tasks:**

1. **Dashboard Overview** `app/(dashboard)/dashboard/page.tsx` + `dashboard-overview.tsx`:
   - Currently: `plutusData.dashboard.metrics`, `maintenanceTrend`, `occupancy`, `activity` + `plutusData.workOrders`, `assets`, `vendors`, `visitors`
   - New: Create server component that calls `requireManagementContext()` to get `siteIds`, `organizationId`, `accessToken`, then parallel fetch via GraphQL:
     - `getSiteKPIs` for each site or `getPortfolioKPIs` for portfolio (metrics: open work orders, occupancy, compliance, visitors)
     - `dailySiteStatsCollection` last 30 days for maintenanceTrend (open vs completed)
     - `sitesCollection` for occupancy (occupied vs available from spaces status)
     - `workOrdersCollection` filter status != completed, first 4 for summary
     - `vendorsCollection` with complianceStatus filter non_compliant
     - `visitsCollection` filter scheduled today
     - `announcementsCollection` or `audit_logs` for activity feed
   - Map to `DashboardData` type expected by `DashboardOverview` component

2. **Work Orders** `app/(dashboard)/dashboard/work-orders/page.tsx`:
   - Currently: `plutusData.workOrders` mock
   - New: Fetch via GraphQL `workOrdersCollection` with filter `siteId eq scopedPropertyId`, `status neq completed`, order by priority, include `sites` relation for propertyName, `profiles` for technician name via assigned_to
   - Map to frontend `WorkOrder` type (number = id slice, propertyName = sites.name, etc)
   - Keep existing filtering UI (search, property, priority, status) but filter on real data via GraphQL filter variables or client-side

3. **Assets** `app/(dashboard)/dashboard/assets/page.tsx`:
   - Currently mock, needs real `assetsCollection` + `v_asset_health` via GraphQL or REST
   - Fetch `assetsCollection` filter siteId, include `assetCategories` for category, `sites` for propertyName, `vAssetHealth` for health, healthScore

4. **Vendors** `app/(dashboard)/dashboard/vendors/page.tsx`:
   - Mock currently, needs `vendorsCollection` + `complianceStatusCollection` + `contracts` + `cois`
   - Fetch `v_compliance_dashboard` via GraphQL or REST for compliance summary

5. **Visitors** `app/(dashboard)/dashboard/visitors/page.tsx`:
   - Mock currently, needs `visitsCollection` filter scheduled today, include visitors full_name, company, host_user_id -> profiles.full_name

6. **Other Dashboard Pages** (create missing ones):
   - `/dashboard/inventory` - `inventoryItemsCollection` + `inventoryStockCollection` + `check_low_stock` via low stock query
   - `/dashboard/reservations` - `reservationsCollection` + `amenitiesCollection`
   - `/dashboard/events` - `eventsCollection` + `eventRsvpsCollection`
   - `/dashboard/access-logs` - `accessLogsCollection`
   - `/dashboard/compliance` - `vComplianceDashboardCollection` or `complianceStatusCollection`
   - `/dashboard/reports` - `reportsCollection` + `reportRunsCollection`
   - `/dashboard/properties` - `sitesCollection` + `buildingsCollection`
   - `/dashboard/organizations` - `organizationsCollection` (already have)
   - `/dashboard/users` - `profilesCollection` + `membershipsCollection`

7. **Tenant Portal** `app/(tenant)/tenant/*`:
   - Already has some real integration? Check `tenant-context.ts` - likely fetches tenant data via REST
   - Wire amenities, announcements, events, requests, reservations, visitors similarly

**Best Practices for Wiring:**

- Use **Server Components** for data fetching (not client useEffect) to keep anonKey + JWT server-side
- Use `requireManagementContext()` to get `accessToken` + `siteIds` + `organizationId`
- Use `graphqlRequest<TData, TVariables>({query, variables, accessToken})` with typed queries
- Handle loading via `loading.tsx` and error via `error.tsx` (Next.js convention, already have some)
- Use `revalidatePath` after mutations (already done in inspection-actions)

### Phase 4: OWASP Mitigations Implementation

**Backend Branch:**

- [x] A01 Broken Access Control: RLS + RBAC already, ensure is_site_manager upgrade in 00002, ensure memberships site_ids filtering
- [ ] A02 Cryptographic Failures: Ensure service_role never in frontend env, ensure storage private buckets with signed URLs, ensure HttpOnly cookies
- [ ] A05 Security Misconfiguration: Create migration to disable introspection in production (comment with introspection: false), or document manual step for prod. Add rate limiting table + Edge Function graphql-gateway with Upstash Redis
- [ ] A09 Logging: Attach log_audit() trigger to all main tables via migration 00018 (currently only generic function exists but not attached to every table)
- [ ] A10 SSRF: Validate storage_path in parse-coi-pdf to start with org_id/site_id that user can_access_site

**Frontend Branch:**

- [ ] A01: Use getScopedPropertyId to prevent access to unauthorized propertyId from URL
- [ ] A02: Ensure .env.local only has public vars, ensure auth-cookies HttpOnly Secure SameSite
- [ ] A03: Use variables in GraphQL, not string interpolation, add zod validation in server actions
- [ ] A05: next.config.ts poweredByHeader false, error messages generic not raw GraphQL errors
- [ ] A07: Rate limiting on sign-in (5 attempts per 15min per IP) via Upstash or in-memory Map
- [ ] A09: Add Sentry for error monitoring, log auth failures

### Phase 5: Testing, Documentation, PR

**Backend Branch Testing:**

- `supabase db reset` → should apply all 17 migrations without errors (fixed)
- Create user demo@cre.local → seed via force seed SQL → counts >0
- GraphQL introspection query should list 50+ fields including portfoliosCollection, sitesCollection, etc (not just PostGIS)
- Test data queries: portfoliosCollection, sitesCollection, workOrdersCollection should return data, not empty
- Test RLS: Create second user with no membership, sign in, query sitesCollection should return empty (no access), not error
- Test mutations: createOrganization, createSiteFull, createWorkOrder, etc

**Frontend Branch Testing:**

- `npm run dev` with .env.local pointing to local Supabase (http://127.0.0.1:54321/...)
- Sign in with demo@cre.local / password123 → should redirect to /dashboard or /tenant based on role
- Dashboard should show real data from backend, not mock plutusData (after wiring)
- Check no service_role key in client bundle (search for sb_secret or service_role in .next)
- Check cookies are HttpOnly (DevTools → Application → Cookies → auth cookies should have HttpOnly flag)
- Test access control: Try to access /dashboard with URL param ?propertyId=some-id-not-in-your-siteIds → should fallback to first allowed site via getScopedPropertyId, not allow unauthorized

**Documentation:**

- In backend repo: Update `docs/FRONTEND_GRAPHQL_INTEGRATION_PLAN.md` (this file) with implementation details, security checklist, how to run
- In backend repo: Create `docs/SECURITY_OWASP_CHECKLIST.md` with A01-A10 and mitigations implemented
- In frontend repo: Create `docs/GRAPHQL_INTEGRATION.md` with env vars, how to run locally with backend, how to add new queries, how to use fragments, how to handle auth, how to test
- In both repos: Update README.md with link to plan and security checklist
- Commit and push to feature branches, not main

---

## 6. Branch Strategy & Execution

**Backend Repo (PlutusPM_api):**
- Current main has 16 migrations, 11 Edge Functions, docs, types, postman, all Docker fixes, GraphQL introspection fix
- New branch: `feat/graphql-frontend-integration-secure` (already created from main at commit 5ffa8c6, now at 1251f74 etc)
- All new work for this plan goes to this branch, not main
- After plan complete, push branch and create PR to main (but don't merge yet per user request)

**Frontend Repo (PlutusPM_dashboard):**
- Current main has mock data, some real integration for management-context and inspections
- New branch: `feat/graphql-backend-integration-secure` (created from main, currently at feature/graphql-integration branch exists, we created new one)
- All new work for wiring GraphQL goes to this branch, not main
- After plan complete, push branch and create PR to main

**Documentation in Both Repos:**
- Backend: `docs/FRONTEND_GRAPHQL_INTEGRATION_PLAN.md` (this file) + `docs/SECURITY_OWASP_CHECKLIST.md` + `docs/FRONTEND_BACKEND_COMPATIBILITY.md` already exists
- Frontend: `docs/GRAPHQL_BACKEND_INTEGRATION_PLAN.md` (copy of this plan adapted for frontend) + `docs/SECURITY.md` + update README with backend integration guide

---

## 7. How to Run After Plan Execution

**Backend (Local Docker):**

```bash
cd PlutusPM_api
git checkout feat/graphql-frontend-integration-secure
git pull origin feat/graphql-frontend-integration-secure

supabase stop --no-backup
supabase start

# Create user + seed
# Studio http://127.0.0.1:54323 -> Auth -> Add User demo@cre.local / password123
# SQL Editor -> Run force seed SQL (creates org, portfolio, 2 sites)
# Or via terminal:
supabase db execute --local --file supabase/migrations/00006_seed_demo.sql (if CLI supports) or psql ...

supabase status # copy anon key, service_role key, API URL, GraphQL URL
```

**Frontend (Local Next.js):**

```bash
cd PlutusPM_dashboard
git checkout feat/graphql-backend-integration-secure
git pull origin feat/graphql-backend-integration-secure

# Create .env.local
cat > .env.local <<EOF
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_GRAPHQL_ENDPOINT=http://127.0.0.1:54321/graphql/v1
NEXT_PUBLIC_REST_ENDPOINT=http://127.0.0.1:54321/rest/v1
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...anon key from supabase status
EOF

npm install
npm run dev
# Open http://localhost:3000
# Sign in with demo@cre.local / password123
# Should see real data from backend in dashboard (after wiring)
```

---

## 8. Security Checklist (OWASP Top 10) - To Be Implemented

| OWASP | Risk | Mitigation Implemented? | How to Test |
|-------|------|------------------------|-------------|
| A01 | Broken Access Control | ✅ RLS + RBAC + is_site_manager + getScopedPropertyId | Create 2 orgs, 2 users each, ensure user A cannot see org B sites via GraphQL even if they guess site_id |
| A02 | Cryptographic Failures | ✅ anonKey public, service_role secret server-only, HttpOnly cookies, private buckets signed URLs | Check frontend bundle for service_role key (should not exist), check cookies HttpOnly flag, check storage files require signed URL |
| A03 | Injection | ✅ GraphQL variables not interpolation, zod validation in server actions | Try injection via search input with "'; DROP TABLE --" should be treated as string, not executed |
| A04 | Insecure Design | ✅ Domain-driven 6 schemas, multi-tenant site_id, secure by default RLS | Review schema design, ensure no public tables without RLS |
| A05 | Security Misconfiguration | ⚠️ Needs work: introspection true in dev, should be false in prod, CORS, rate limiting, verbose errors | In prod, set introspection false via comment, add graphql-gateway Edge Function with rate limiting 60 req/min, disable GraphQL playground |
| A06 | Vulnerable Components | ⚠️ Needs Dependabot, npm audit | Enable Dependabot in GitHub repo settings, run npm audit fix |
| A07 | Auth Failures | ✅ Supabase Auth session HttpOnly, JWT ES256, refresh rotation, but needs rate limiting + MFA | Test brute force sign-in 10 times quickly should block after 5, check rate limiting |
| A08 | Software/Data Integrity | ✅ Edge Functions verify_jwt true except public, storage RLS path validation, no eval | Check parse-coi-pdf validates storage_path starts with org_id, check no arbitrary URL fetch |
| A09 | Logging Failures | ⚠️ Partial: audit_logs exists but not attached to all tables, no Sentry | Attach log_audit trigger to all main tables, add Sentry in frontend |
| A10 | SSRF | ✅ pg_net only calls trusted Supabase functions URL, no user-controlled URL | Check parse-coi-pdf, amenity-booking, etc don't fetch user-controlled URL without allowlist |

---

## 9. Timeline (Estimated)

- **Phase 1 Backend Hardening:** 1-2 days (migration 00018 for audit triggers, access_requests table, rate limiting, graphql-gateway Edge Function, docs)
- **Phase 2 Frontend Secure Client:** 0.5 day (env vars, zod, rate limiting on sign-in)
- **Phase 3 Wiring Dashboard:** 3-4 days (replace mock plutusData with real GraphQL in 8+ dashboard pages + 8 tenant pages)
- **Phase 4 OWASP Mitigations:** 1 day (introspection prod disable, rate limiting, Sentry, etc)
- **Phase 5 Testing & Docs:** 1 day (test RLS, test auth, test GraphQL, update READMEs)

Total: ~1 week for full secure GraphQL integration

---

## 10. Next Steps (After Planning)

1. Review this plan (backend docs/FRONTEND_GRAPHQL_INTEGRATION_PLAN.md)
2. Create same plan in frontend repo docs/
3. Start implementation in feature branches, not main
4. Document every change in both repos
5. Push branches, create PRs, but don't merge to main until user approves
6. Final demo: Frontend .env.local pointing to local Supabase, sign in, see real data from backend in dashboard, not mock

**User said: After plan is done execute it but not in main branches create a new branch per repo and make changes there document everything in both repos continue**

So after this plan is reviewed, we will start execution in feature branches.
