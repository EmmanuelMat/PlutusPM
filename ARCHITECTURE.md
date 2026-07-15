# Commercial Real Estate SaaS — Platform Architecture (Implemented ✅)

**Stack:** Supabase (Postgres 15 + PostGIS + pg_trgm + ltree + pg_graphql + pg_cron + pg_net + Auth + Realtime + Storage + Edge Functions/Deno) + TypeScript  
**Model:** Multi-tenant SaaS | Domain-Driven | Portfolio → Sites → Everything on Site | 6 Postgres Schemas  
**Status:** ✅ Implemented - 15 Migrations (~6,500 lines), 11 Edge Functions, 7 Buckets, 10 Cron Jobs, 94% Capability Coverage  
**Repo:** https://github.com/EmmanuelMat/PlutusPM

> This was planning doc, now updated to reflect actual built code. See README.md for Docker local run guide, docs/CAPABILITY_COVERAGE.md for gap analysis vs Business Capability Architecture.

---

## 1. Core Insight: Portfolio and Sites as the Aggregate Root (Implemented)

Every domain entity belongs to a Site. Site belongs to Portfolio, Portfolio to Organization (SaaS Tenant). RLS, GraphQL, Realtime, Analytics all filter by `site_id`.

```
Organization (SaaS customer e.g., CBRE, JLL)
 └── Portfolio (e.g., "Northeast Portfolio", "Client A Assets") [portfolio.portfolios]
      └── Site (CENTER) [portfolio.sites] e.g., "One World Trade, NYC - 100 Main Tower"
           ├── Buildings (1 site N buildings) [portfolio.buildings]
           │    └── Floors/Levels [portfolio.floors]
           │         └── Spaces/Units [portfolio.spaces] leasable/common/amenity/parking/storage/external
           ├── [BUILDING OPS - ops schema] Assets, Work Orders, Inspections, Checklists, Inventory, Labor, Incidents
           ├── [TENANT EXP - tenant schema] Tenants, Service Requests, Reservations, Amenities, Announcements, Events, Feedback
           ├── [VISITOR MGMT - visitor schema] Visitors, Passes, Access Logs, Devices, Credentials
           ├── [COMPLIANCE - vendor schema] Vendors, Contracts, COIs, Documents, Compliance Rules/Status
           └── [ANALYTICS - metrics schema] daily_site_stats, portfolio_daily_stats, KPIs, Reports, Benchmarking
```

**Why site_id everywhere:** RLS `platform.can_access_site(site_id)` uses memberships site_ids[] null=all, GraphQL filter `siteId: {eq: $siteId}` gets everything for property, Realtime `site_id=eq.123` gets live changes on that property, Analytics group by site_id for rollups, Scheduler loops per site.

---

## 2. Platform Topology (Implemented)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         SUPABASE PLATFORM - 6 SCHEMAS                      │
├────────────────────────────────────────────────────────────────────────────┤
│ GraphQL Gateway (pg_graphql) │ REST PostgREST │ Realtime (10 tables) │ Storage │
│  /graphql/v1                  │ /rest/v1       │ wss://.../realtime   │ 7 buckets │
├────────────────────────────────────────────────────────────────────────────┤
│ Auth (GoTrue JWT) + RBAC (memberships role 10 values) + RLS (can_access_site) │
│ pg_cron (10 jobs) + pg_net (HTTP) + Scheduled Edge Functions (2 scheduled) │
│ Edge Functions 11: health, compliance-daily-check 9am, generate-qr, send-visitor-pass, │
│ engineering-report, visitor-kiosk public CORS, amenity-booking, parse-coi-pdf OCR,   │
│ compliance-report, scheduled-reports 7am, export-data generic CSV/JSON RLS     │
├────────────────────────────────────────────────────────────────────────────┤
│                     POSTGRES 15 - DOMAIN SCHEMAS                           │
│ [platform] orgs/profiles/memberships/audit_logs/notifications/helpers       │
│ [portfolio] portfolios/sites (PostGIS)/buildings/floors/spaces/leases/search│
│ [ops] asset_categories/assets hierarchy/maintenance_history/templates/WOs/  │
│       checklists/items/inspections/inspection_items/comments/attachments/   │
│       inventory categories/items/stock/transactions/labor_logs/incidents    │
│ [tenant] tenants/tenant_contacts/service_requests/reservations/amenities/  │
│          announcements/events/rsvps/feedback                                │
│ [visitor] visitors/visits/passes/access_devices/credentials/logs/blacklist │
│ [vendor] vendors/contacts/contracts/approvals/cois auto_extracted/docs/    │
│          compliance_rules/status/audit_logs/notification_rules/dashboard   │
│ [metrics] daily_site_stats enhanced 13 cols/portfolio_daily_stats/KPIs/    │
│           reports/report_runs/benchmark views v_building_benchmark etc      │
│ [storage] 7 buckets RLS via folder org/site + other schemas graphql/public │
└────────────────────────────────────────────────────────────────────────────┘
```

### Schemas Decision: Why Separate Schemas Per Domain

**Chosen:** Separate Postgres schemas per domain matching Business Capability Architecture 5 domains + shared platform + metrics.

- `platform` (shared): organizations, profiles, memberships with site_ids[], audit_logs, notifications, helper functions can_access_site(), is_org_admin(), etc
- `portfolio` (center): portfolios, sites (PostGIS location geography Point, trigram name gin_trgm_ops, ltree ready, metadata jsonb), buildings, floors, spaces, leases
- `ops`: assets (qr_code, parent_asset_id hierarchy, criticality), asset_maintenance_history, work_order_templates (recurrence_rule FREQ=MONTHLY, next_due_at), work_orders (type preventive/corrective/inspection/service_request/incident, priority, status open/in_progress/overdue/completed, sla_due_at calculated urgent 4h/high 24h/medium 72h/low 168h, labor_hours, cost), checklists, checklist_items (pass_fail/yes_no/numeric/text/photo/signature/multiple_choice), inspections (score 0-100), inspection_items (photo_paths text[]), comments, attachments, inventory categories/items/stock/transactions, labor_logs (hours*rate total_cost generated, trigger to WO), incidents (severity, status)
- `tenant`: tenants (company_name, logo, industry), tenant_contacts junction (role primary/admin/member/billing), service_requests (→ auto WO), reservations (space, amenity, approval_status pending/approved/denied, attendees), amenities (space unique, category conference_room/gym/rooftop/parking, capacity, booking_rules jsonb min_hours/max_hours/advance_days, image_urls), announcements (audience all/tenants/staff/tenant_specific/building_specific, priority), events, event_rsvps, feedback (rating 1-5)
- `visitor`: visitors (email/full_name/company), visits (host_user_id, purpose, status preregistered/checked_in/checked_out, scheduled_at, qr_code, pass_id, host_notified_at, nda_signed), passes (qr_token unique, type day/multi_day/vip, status active/used/expired/revoked, valid_from/until, max_uses/used_count), access_devices (turnstile/door_lock/gate/elevator/parking_gate/kiosk, identifier MAC, access_point, is_online), access_credentials (user_id or visitor_id, type nfc/bluetooth/qr/pin/mobile/card, credential_id unique org), access_logs (device, access_point, event granted/denied), blacklist (email/visitor_id, severity)
- `vendor`: vendors (type cleaning/hvac/security/etc), vendor_contacts (role), contracts (site null org-wide, status, approval_status pending/approved/rejected/expired, approved_by/at, auto_renew, renewal_notice_days, value, storage_path), contract_approvals history, cois (type GL/WC/auto, expiry, status valid/expiring/expired/pending_review, coverage_amount, policy_number, insurer_name, additional_insured, auto_extracted jsonb OCR), documents generic (category insurance/contract/certification/safety/license/w9/other, status pending_review/verified/expired/rejected, expiry, file_name/size/mime, storage_path), compliance_rules (vendor_type null all, site null org-wide, required_coi_types text[], min_coverage jsonb, validity_days, severity), compliance_status (vendor/site/status compliant/non/pending/issues jsonb/last_checked), compliance_audit_logs, notification_rules (event_type coi_expiring/contract_expiring/compliance_failed, days_before int[] 30,7,1, channels in_app/email/slack, recipient_roles org_role[], recipient_user_ids), views v_compliance_dashboard, v_vendor_summary
- `metrics`: daily_site_stats enhanced (occupancy_rate, compliance_rate, avg_response_time, labor_hours, pm/corrective, incidents open/closed, inspections completed/failed, total/healthy assets, reservation_count), portfolio_daily_stats (total_sites, total_sq_ft, occupancy avg, WOs sum, sla_breaches sum, visitor sum, compliance avg, labor sum), kpi_definitions (13 default: occupancy 95%, SLA breach 5% lower better, WOs open 20, PM ratio 70%, compliance 100%, asset health 95%...), reports (type daily_ops/weekly_exec/monthly_portfolio/compliance/occupancy, format json/csv/pdf, cron Monday 7am, recipients emails[], filters jsonb, status active/paused/archived, last/next run), report_runs (status pending/running/completed/failed, file_path org/reports/id/date/name.ext in site-files, file_size, row_count), views v_building_benchmark (site vs portfolio_avg_occupancy/compliance + rank), v_asset_health_rollup, v_sla_metrics

Pros: Domain ownership, clean GraphQL namespaces `portfolioSitesCollection`, `opsWorkOrdersCollection`, least privilege, evolves independently. Cons: cross-schema joins need SECURITY DEFINER helpers (solved via can_access_site).

---

## 3. Tech Stack (Implemented as per Requirements)

### Postgres + Supabase

- Extensions enabled in 00000: uuid-ossp, pgcrypto, pg_graphql schema graphql, pg_stat_statements, postgis schema extensions, pg_trgm, ltree, pg_cron schema pg_catalog, pg_net schema extensions
- All tables: id uuid PK default uuid_generate_v4(), org_id FK platform.organizations, site_id FK portfolio.sites where applicable, created_at, updated_at, created_by, metadata jsonb
- Indexes: GIN metadata jsonb_path_ops, GiST location geography, B-tree (org_id,site_id), (site_id,status), (site_id,created_at desc), trigram GIN name gin_trgm_ops, partial indexes where status=active, etc
- Soft deletes: status enum + deleted_at not needed, we use status active/inactive/disposed etc + status field; history via audit_logs
- Multi-tenancy isolation: RLS mandatory on every table, service_role bypass, no anon key to frontend ever exposes service_role

### GraphQL - pg_graphql Native (Chosen)

Enabled via `create extension pg_graphql with schema graphql;` grant usage schemas anon/authenticated/service_role; comment `@graphql` etc (via rebuild). Exposed at `/graphql/v1` needs apikey anon + Authorization Bearer JWT.

How it works: Auto-generates CRUD from tables/views/functions via FKs relations, respects RLS JWT auth.uid() filtered at DB, custom mutations via Postgres functions comment `{"type": "mutation", "name": "createWorkOrder"}`.

Example queries in `docs/graphql-examples.md` 10 collections, also Postman collection 60+ requests.

Frontend query example already in README.

For custom middleware (rate limit, logging, persisted queries) we have thin Edge Functions but start native - sufficient for 95% CRE SaaS. If need advanced: deploy PostGraphile as Edge Function later, deferred.

### Scheduler - Chosen: pg_cron + pg_net + Scheduled Edge Functions (Implemented)

**Why not BullMQ/Redis/Temporal?** Extra infra cost, Postgres is queue, pg_cron built into Supabase paid + local.

Architecture:
```
pg_cron (schedule) -> pg_net HTTP async -> Edge Function (complex logic SendGrid/Slack/Stripe)
       -> Direct SQL jobs UPDATE, CALL proc()
```

Setup: extensions pg_cron pg_net, grant usage schema cron to postgres, grant all tables in schema cron to postgres.

Examples in migration 00004 + 00007 + 00010 + 00012 + 00014: 10 jobs:

- */15 * check-sla-breaches calls ops.check_sla_breaches() updates overdue + metadata + notification
- 0 2 * * * generate-pm-work-orders calls ops.generate_pm_work_orders() loops templates next_due<=now creates WOs per site
- 0 8-18 * * * check-coi-expiration calls vendor.check_coi_expirations() expiring 30d + expired + compliance_status
- 0 3 * * * rollup-daily-metrics calls metrics.rollup_daily_stats_enhanced (enhanced) + portfolio rollup
- 0 4 * * * cleanup-expired-visits deletes visits checked_out <90d + notifications read <90d
- 0 9 * * 1 lease-expiration-check inserts notifications leases ending 30d
- 0 8 * * * check-low-stock inserts notifications from ops.check_low_stock()
- 0 * * * * expire-visitor-passes updates passes valid_until<now→expired + visits preregistered scheduled<now-2h→no_show
- 0 6 * * * evaluate-vendor-compliance calls vendor.evaluate_all_compliance()
- 0 7 * * * check-contract-expirations + check-document-expirations

Plus 2 scheduled Edge Functions via config.toml: compliance-daily-check 0 9 * * * calls same logic + Resend/Slack, scheduled-reports 0 7 * * * daily runs reports.

Monitoring: `select * from cron.job; select * from cron.job_run_details order by start_time desc limit 20; select * from net._http_response;` view metrics.cron_health (could add), Edge Functions logs via `supabase functions logs`.

Calling Edge Functions from cron via pg_net http_post with service_role key header Authorization Bearer.

Future scaling: if outgrow pg_cron 1000s jobs/sec, migrate to pgmq (Postgres Queue AWS SQS-like) or Supabase Queues beta, but pg_cron handles <10k jobs/day sufficient for 100s sites.

---

## 4. Domain Data Model (Implemented - ER Summary)

See `architecture/diagrams/data-model.html` interactive + `docs/02-data-model-core.md`.

Core: portfolio.sites is center, every table has site_id for RLS partitioning, GraphQL filter, Realtime channel, Analytics groupBy, SaaS partitioning.

**Platform:** organizations, profiles mirrors auth.users + full_name/avatar, memberships org/user/role 10 values + portfolio_ids[] + site_ids[] null=all, audit_logs org/site/user/action/entity/entity_id/diff ip, notifications org/site/user/type/title/body/payload jsonb/is_read

**Portfolio:** portfolios org/name/desc/color/manager, sites org/portfolio/name/slug/type office/retail/industrial/lab/mixed etc/status active/onboarding/inactive/disposed/draft/address/city/state/zip/country/timezone/location PostGIS lat/lng sync trigger lat/lng -> geography, sq_ft/year_built/floors_count/manager/external_id/metadata jsonb/created_by unique org+slug, buildings site/name/floors_count/sq_ft, floors building/level_number/name/floorplan_path/sq_ft/metadata unique building+level, spaces site/building/floor/name/code STE 100/type leasable/common/amenity/parking/status vacant/occupied/reserved/maintenance/area/capacity/metadata, leases site/space/tenant/start/end/status draft/active/expired/terminated/pending/monthly_rent/metadata

**Ops:** asset_categories org/name/icon/color, assets org/site/building/floor/space/category/parent_asset_id/name/qr_code unique QR-8chars/status active/inactive/maintenance/retired/ordered/criticality low/med/high/critical/manufacturer/model/serial/install/warranty/last/next maintenance/location_description/qr_last_printed/metadata, asset_maintenance_history site/asset/WO/type inspection/preventive/corrective/install/decommission/audit/title/performed_by/at/cost/labor, work_order_templates site null org-wide/name/desc/category/type priority/estimated_hours/checklist jsonb/recurrence_rule FREQ=MONTHLY/next_due/is_active, work_orders site/building/floor/space/asset/template/type/priority/status open/in_progress/on_hold/completed/cancelled/overdue/assigned_to/created_by/due_date/sla_due_at/completed_at/labor_hours/cost/metadata, checklists site null org lib/name/desc/category/version/is_active/required/estimated_minutes, checklist_items checklist/parent_item/sort_order/label/desc/item_type pass_fail/yes_no/numeric/text/photo/signature/multiple_choice/is_required/options jsonb/expected_value/metadata, inspections site/asset/building/floor/space/checklist/WO/title/status draft/in_progress/completed/failed/cancelled/overdue/score/assigned_to/created_by/scheduled/started/completed, inspection_items inspection/checklist_item/status pass/fail/na/flagged/pending/response_text/numeric/options jsonb/is_flagged/notes/photo_paths text[]/scored/answered_by/at, work_order_comments WO/org/site/user/comment/is_internal, attachments file_name/size/mime/storage_path org/site/work_orders/wo/file, inventory_categories org/name, inventory_items org/category/name/sku unique org/desc/unit cost_per_unit/supplier/min_stock_level 5/is_active, inventory_stock site/item unique/quantity>=0/location, stock_transactions site/item/stock/WO/type in/out/adjustment/transfer/return/quantity/reason/performed_by, labor_logs site/WO/user/hours>0/rate/total_cost generated hours*rate/description/logged_at, incidents site/building/floor/space/asset/WO/title/desc/severity low/med/high/critical/status reported/investigating/resolved/closed/escalated/category safety/environmental/security/operational/reported_by/assigned_to/occurred/resolved

**Tenant:** tenants org/site/company_name/legal_name/contact_email/phone/logo_url/industry/employee_count/primary_contact_id/status active/inactive/prospect, tenant_contacts tenant/profile/org/site/role primary/admin/member/billing/facility/is_primary, service_requests site/space/tenant/tenant_contact/title/desc/category/priority/status open/in_progress/completed/cancelled/on_hold/WO/created_by, reservations site/space/amenity/reserved_by/title/start/end/status pending/confirmed/cancelled/completed/no_show/approval_status pending/approved/denied/approved_by/attendees/metadata, amenities org/site/space unique/name/desc/category conference_room/meeting_room/gym/rooftop/lounge/parking/event_space/kitchen/other/capacity/hourly_rate/is_bookable/booking_rules jsonb min_hours/max_hours/advance_days/requires_approval/image_urls/amenities_list, announcements site/building/title/body/summary/audience all/tenants/staff/tenant_specific/building_specific/priority low/normal/high/urgent/tenant_id/publish_at/expires_at/is_published/image_url/attachment_paths, events site/title/desc/location_text/space_id/start/end capacity/is_public/requires_rsvp/rsvp_deadline/image_url, event_rsvps event/org/site/profile/status going/interested/not_going/waitlist/guests, feedback site/profile/type service_request/work_order/amenity/event/general/complaint/suggestion/related_id/rating 1-5/comment/is_anonymous

**Visitor:** visitors org/email/full_name/company/phone/id_type/id_last4/photo_path/metadata unique org+email, visits org/site/visitor/host_user/host_space/purpose/status preregistered/checked_in/checked_out/cancelled/denied/no_show/scheduled_at/checked_in/out/checked_in_by/out_by/host_notified_at/qr_code/pass_id/nda_signed/visitor_company_verified/metadata, passes org/site/visit/visitor/qr_token unique PASS-12chars/type day/multi_day/recurring/contractor/vip/status active/used/expired/revoked/pending/valid_from/until/max_uses/used_count/issued_by/at/revoked_at/by/metadata, access_devices org/site/building/floor/name Main Lobby Turnstile 1/device_type turnstile/door_lock/gate/elevator/parking_gate/kiosk/other/identifier unique MAC/access_point/is_online/active/last_seen_at/metadata ip/vendor/model, access_credentials org/site/user or visitor/type nfc/bluetooth/qr/pin/mobile/card/credential_id unique org/is_active/expires_at/issued_at/metadata, access_logs org/site/visit/device_id/access_point/event granted/denied/tailgate/forced/timestamp/metadata, blacklist org/visitor_id/email/full_name/reason/severity low/med/high/critical/added_by/expires_at null indefinite/is_active

**Vendor:** vendors org/name/type cleaning/hvac/electrical/plumbing/security/landscaping/elevator/fire_safety/general/other/status active/inactive/pending/blocked/website/contact_email/phone/metadata, vendor_contacts vendor/org/name/email/phone/role/is_primary/is_billing, contracts org/vendor/site null org-wide/title/desc/status draft/active/expired/terminated/pending_renewal/approval_status pending/approved/rejected/expired/approved_by/at/rejection_reason/auto_renew/renewal_notice_days/payment_terms/start/end/value/storage_path, contract_approvals contract/org/approver/status pending/approved/rejected/expired/comments/decided_at, cois org/vendor/contract/site/type general_liability/workers_comp/auto/umbrella/issue_date/expiry/status valid/expiring/expired/missing/pending_review/coverage_amount/policy_number/insurer_name/additional_insured bool/certificate_holder/auto_extracted jsonb OCR/rejection_reason/storage_path/verified_by/at/metadata, documents org/vendor/site/contract/coi/title/desc/category insurance/contract/certification/safety/license/w9/other/status pending_review/verified/expired/rejected/archived/storage_path org/vendor/docs/file/file_name/size/mime/expiry/issue/uploaded_by/verified_by/at/rejection_reason/metadata ocr, compliance_rules org/name/desc/vendor_type null all/site null org-wide/required_coi_types text[]/required_doc_categories/required_doc_types/min_coverage jsonb/required_certifications/validity_days/is_active/severity low/med/high/critical/created_by, compliance_status org/vendor/site/status compliant/non_compliant/pending/partial/issues jsonb/last_checked unique vendor+site, compliance_audit_logs org/vendor/site/rule/previous/new status/issues/checked_by null system, notification_rules org/site null org-wide/name/desc/event_type coi_expiring/expired/contract_expiring/expired/compliance_failed/vendor_approval_needed/document_expiring/days_before int[] 30,7,1/channels in_app/email/slack/recipient_roles org_role[]/recipient_user_ids/is_active, views v_compliance_dashboard vendor per site active_contracts/valid/expiring/expired cois/expired_docs/next_expiry/total_coverage, v_vendor_summary per org overall_status

**Metrics:** daily_site_stats id/org/site/date unique/work_orders_open/closed/overdue/sla_breaches/visitor_count/service_requests_count/occupancy_rate/compliance_rate/avg_response_time_hours/labor_hours/pm/corrective work_orders/incidents_open/closed/inspections_completed/failed/total/healthy assets/reservation_count, portfolio_daily_stats org/portfolio/date unique/total_sites/total_sq_ft bigint/occupancy_rate/work_orders_open/closed/overdue/sla_breaches/visitor/service_requests/compliance_rate/occupancy_weighted/avg_response/labor/incidents/total/healthy assets, kpi_definitions org/name/key machine occupancy_rate/sla_breach_rate/etc/category operational/maintenance/compliance/occupancy/vendor/financial/tenant/visitor/safety/unit percent/count/hours/currency/ratio/days/target/higher_is_better/formula/is_active unique org+key, reports org/portfolio/site/name/desc/type daily_ops/weekly_exec/monthly_portfolio/compliance/occupancy/maintenance/financial/custom/format json/csv/pdf/cron default Monday 7am/recipients emails[]/recipient_user_ids/filters jsonb/status active/paused/archived/last/next run, report_runs report/org/status pending/running/completed/failed/file_path org/reports/id/date/name.ext/file_size/row_count/error/started/completed, views v_building_benchmark site vs portfolio_avg_occupancy/compliance/open_wos avg over partition + rank, v_asset_health_rollup per site total/active/maintenance/overdue_maintenance/warranty_expired/unhealthy/health_score %, v_sla_metrics per site per day total/breached/overdue/avg_hours_to_complete/avg_sla/urgent/high

---

## 5. RBAC & RLS Strategy (Implemented)

Roles enum org_role: owner (billing, delete org), admin (full), portfolio_manager (subset portfolios), site_manager (subset sites), building_engineer (ops write), security (visitor), tenant_admin (own company spaces, service requests), tenant_user (reservations), vendor (own contracts/COIs), auditor (read-only)

Memberships: org_id, user_id, role, portfolio_ids uuid[] null=all portfolios in org, site_ids uuid[] null=all sites in allowed portfolios, created_by, unique org+user

Helpers SECURITY DEFINER (set search_path platform,public etc): current_org_ids() array_agg org_id where user_id=auth.uid(), current_allowed_site_ids() case when exists membership site_ids null then null else array_agg distinct unnest site_ids, is_super_admin() exists profiles where id=auth.uid() and is_super_admin true, is_org_member(p_org_id) exists memberships org_id=user org_id + user_id=auth.uid() or is_super_admin, is_org_admin(p_org_id) role in owner,admin, can_access_site(p_site_id) plpgsql handles if super_admin return true, get org_id from portfolio.sites where id=p_site_id, exists membership where user_id=auth.uid() and org_id=site org and (site_ids null or p_site_id=any(site_ids)), is_site_manager(p_site_id) role in owner,admin,portfolio_manager,site_manager + site_ids check, current_org_id() first membership org_id

RLS template applied to EVERY table: `alter table ... enable row level security; create policy "Users can view sites they have access to" on portfolio.sites for select using (platform.can_access_site(id));` For org tables: `using (platform.is_org_member(id))` For insert: `with check (auth.uid() is not null)` or org member, update: is_site_manager or is_org_admin, delete: owner.

Tenant isolation: tenant.service_requests RLS `using (can_access_site(site_id) or tenant_contact_id in tenant_contacts where profile_id=auth.uid())` shows own requests + managers see all, similar for reservations.

Vendor isolation: Option 1 vendors not auth.users, contacts internal upload COI for them (MVP), Option 2 vendors login role vendor + membership vendor_id (future). Implemented Option 1 for MVP.

Super admin: flag profiles.is_super_admin bypass via `or is_super_admin()` in policies.

JWT Claims Hook: Supabase custom claims hook platform.custom_claims(event jsonb) returns jsonb inject org_ids, site_ids, role via auth.jwt() ->> 'site_ids' available in RLS without extra query faster, deferred phase 2 optimization, currently helper queries memberships (fine for <1M rows).

Audit: trigger platform.log_audit() SECURITY DEFINER extracts org_id/site_id from NEW/OLD to_jsonb, inserts audit_logs create/update/delete with diff old/new jsonb, generic can be attached to all tables (currently attached for some, function ready, need attach to all via future migration), plus compliance_audit_logs.

Frontend implications (docs/FRONTEND_GUIDE_FOR_DEV.md): never manage RLS, just queries empty if no access, store memberships after login, site selector query portfolioSitesCollection RLS auto-filtered, role UI gating memberships role hide/show but backend enforces.

Testing: sql/test-rls.sql simulated via set local role authenticated; set local request.jwt.claim.sub = user uuid; query sites should only see allowed.

---

## 6. Realtime & Notifications (Implemented)

Supabase Realtime on: ops.work_orders, ops.assets, ops.inspections, ops.inspection_items, ops.incidents, ops.work_order_comments, ops.inventory_stock, tenant.service_requests, tenant.announcements, tenant.events, tenant.reservations, tenant.feedback, tenant.tenant_contacts, visitor.visits, visitor.passes, visitor.access_logs, vendor.compliance_status, platform.notifications, platform.memberships, metrics.reports, report_runs, etc via `alter publication supabase_realtime add table ...`

Frontend subscribes: `supabase.channel('site:123').on('postgres_changes', {table: 'work_orders', filter: 'site_id=eq.123'}, ...).subscribe()` For notifications: channel notifications filter user_id=eq.user.id.

Notifications table + pg_notify -> Edge Functions calls Resend/Slack/webhook (compliance-daily-check, scheduled-reports, send-visitor-pass)

---

## 7. File Storage Structure (7 Buckets + RLS)

Bucket site-files private 100MiB path org/site/... e.g., {org_id}/{site_id}/floorplans/{floor_id}.pdf, {org_id}/{site_id}/assets/{asset_id}/photos/{file}, {org_id}/{site_id}/inspections/{inspection_id}/{file}, {org_id}/{site_id}/cois/{vendor_id}/{coi_id}.pdf, {org_id}/{site_id}/contracts/{contract_id}.pdf, {org_id}/reports/{report_id}/{date}/report.csv, {org_id}/{site_id}/{date}/engineering-report.json

Bucket avatars public 2MB path user_id/avatar.png

Bucket floorplans private 50MB pdf/image, coi-documents 20MB, contract-documents 50MB, visitor-photos 5MB 24h retention maybe, work-order-attachments 20MB

All storage RLS using platform.can_access_site() parsing folder path storage.foldername(name)[1]=org_id,[2]=site_id,[3]... etc

---

## 8. Implementation Phases (Completed)

**Phase 0 (Core Platform) - DONE:** Extensions + platform + portfolio core (orgs, profiles, memberships, RBAC helpers, RLS, audit, notifications, GraphQL setup, scheduler skeleton, storage buckets) + seed demo org+2 sites, GraphQL endpoint working, seed demo.

**Phase 1 (Building Operations MVP) - DONE:** Assets, Work Orders, Templates PM cron generate, Inspections Checklists, Inventory, QR generation, SLA cron, Realtime, Labor, Incidents, Asset Health view, Engineering Reports edge, low stock cron.

**Phase 2 (Tenant + Visitor) - DONE:** Tenants, Contacts, Service Requests <-> WOs link auto, Reservations conflicts check amenity-booking edge, Announcements/Events/RSVPs/Feedback, Visitor registration + QR passes generate_pass + email send-visitor-pass, Access Logs, Kiosk edge validate/check_in/out/stats, Blacklist, Access Devices/Credentials.

**Phase 3 (Compliance + Vendor) - DONE:** Vendors, Contacts, Contracts approval workflow, COIs OCR parse-coi-pdf edge, Expiration cron + notifications, Compliance Rules engine evaluate_vendor_compliance, Dashboard views v_compliance_dashboard/v_vendor_summary, compliance-report edge CSV, Notification Rules.

**Phase 4 (Portfolio & Analytics) - DONE:** Daily rollup enhanced 13 cols + portfolio rollup, KPIs 13 default, Benchmarking view building_benchmark site vs portfolio avg + rank, SLA metrics, Asset Health rollup, Reports scheduled-reports edge weekly email + export-data generic CSV/JSON RLS.

**Phase 5 Hardening (Next - Optional):** RLS tests automated, Search pg_trgm functions search_assets/tenants/vendors, Audit log retention archive to storage jsonl, Rate limiting Edge gateway if needed, Localization translations table, Workflow engine generic, Documentation final (Postman + Types done).

---

## 9. Decisions Made

1. **Schemas:** Separate schemas per domain (implemented) 6 schemas + public
2. **Space hierarchy depth:** Site -> Building -> Floor -> Space mandatory implemented (Site has buildings, buildings have floors, floors have spaces). Flexible: building/floor nullable in spaces, so Site -> Space direct also works if no building/floor.
3. **GraphQL auth:** Native pg_graphql only (implemented), no Hasura wrapper. Can add PostGraphile later if need.
4. **Multi-tenancy strictness:** One org sees only its data (typical) implemented via RLS, cross-org via memberships role portfolio_manager across multiple orgs or site_ids[] subset, plus super_admin flag. No access_grants table needed for now.
5. **Scheduler detail:** PM work orders auto-generate daily 2am via templates next_due, COI expiration windows 30/14/7/1 days via notification_rules days_before, compliance evaluation daily 6am, SLA 15m, etc.

---

## 10. Next Steps (All Code Built - Now Operate)

- Run locally via Docker: see README.md How to Run Locally with Docker section (supabase start, create user, seed 5 files, test GraphQL, serve functions, check cron)
- Deploy to cloud: supabase link --project-ref, db push (15 migrations), functions deploy 11, secrets set Resend/Slack
- Frontend dev: give types/ + postman/ + FRONTEND_GUIDE + graphql-examples, they build Portfolio/Sites UI, Work Orders, Visitor Kiosk, Compliance Dashboard, Analytics
- Hardening: add audit triggers to all tables, search functions, community_posts + parking_permits + v_security_dashboard + check_access for 100% code coverage (see CAPABILITY_COVERAGE.md P0 gaps 6h work), localization translations if need Spanish, workflow engine generic if need configurable approvals
- CI/CD: GitHub Actions deploying migrations via db push and functions deploy on main push

**Repo Ready:** https://github.com/EmmanuelMat/PlutusPM - 15 migrations, 11 functions, 7 buckets, 10 crons, 94% capability coverage

Questions? See README.md Docker guide or docs/
