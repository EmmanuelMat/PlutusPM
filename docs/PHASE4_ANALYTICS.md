# Phase 4 - Portfolio & Analytics - Complete (Final Domain)

**Status:** Built, migrations 00014 + 00015 + 2 new Edge Functions  
**Domain:** Portfolio & Analytics (final of 5 domains + shared platform)

This completes all 5 business capability domains from your architecture doc.

---

## What Phase 4 Adds

### Before vs Now

| Before (Phase 0-3) | Now (Phase 4 Full) |
|-------------------|-------------------|
| daily_site_stats basic (open/closed) | + occupancy, compliance, response time, labor, pm vs corrective, incidents, inspections, assets |
| No portfolio rollup | portfolio_daily_stats aggregated + weighted occupancy |
| No KPIs | kpi_definitions (13 default KPIs) + get_site_kpis(), get_portfolio_kpis() |
| No benchmarking | v_building_benchmark (site vs portfolio avg, rank), v_asset_health_rollup, v_sla_metrics |
| No scheduled reports | reports + report_runs + scheduled-reports edge function (cron daily 7am, email via Resend, signed URLs) |
| No data export | export-data function (any table filtered by site/date, CSV/JSON, RLS with user JWT) |

### Tables:

**metrics.kpi_definitions**
- `name, key (machine), description, category: operational|maintenance|compliance|occupancy|vendor|financial|tenant|visitor|safety, unit: percent|count|hours|currency|ratio|days, target_value, higher_is_better bool, formula jsonb, is_active`
- Function `create_default_kpis(org_id)` seeds 13 KPIs:
  - Occupancy Rate 95% target, SLA Breach Rate 5% (lower better), Work Orders Open, Closed Today, Avg Response Time 4h, PM Ratio 70%, Compliance Rate 100%, Non-Compliant Vendors 0, Visitor Count, Service Request Avg 24h, Asset Health Score 95%, Labor Hours, Incidents Open 0

**metrics.daily_site_stats** - Enhanced with 13 new columns:
- `occupancy_rate, compliance_rate, avg_response_time_hours, labor_hours, pm_work_orders, corrective_work_orders, incidents_open, incidents_closed, inspections_completed, inspections_failed, total_assets, healthy_assets, reservation_count`
- Populated by `rollup_daily_stats_enhanced(date)` which:
  - Occupancy: leased leasable spaces / total leasable *100 from portfolio.spaces
  - Compliance: compliant vendors / total vendors for site from vendor.compliance_status
  - Avg response: avg hours to complete WOs that day
  - Labor: sum labor_logs hours that day
  - PM vs corrective counts
  - Incidents open/closed that day
  - Inspections completed/failed
  - Total assets / healthy assets (status active)
  - Reservations count
  - Also counts work_orders_open/closed/overdue, sla_breaches, visitor_count, service_requests (existing)

**metrics.portfolio_daily_stats**
- Rollup from daily_site_stats per portfolio: `total_sites, total_sq_ft, occupancy_rate avg, work_orders_open sum, closed, overdue, sla_breaches sum, visitor_count sum, service_requests sum, compliance_rate avg, avg_response_time avg, labor_hours sum, incidents_open sum, total_assets sum, healthy_assets sum`
- Unique per portfolio_id + date
- Function `rollup_portfolio_daily_stats(date)` loops portfolios, aggregates from sites where portfolio_id = ...

**metrics.reports**
- Scheduled report definitions: `org_id, portfolio_id nullable, site_id nullable (null=all), name, description, type: daily_ops|weekly_exec|monthly_portfolio|compliance|occupancy|maintenance|financial|custom, format: json|csv|pdf, schedule_cron default "0 7 * * 1" (Monday 7am), recipients text[] emails, recipient_user_ids uuid[], filters jsonb (include fields, date_range), status active|paused|archived, last_run_at, next_run_at`
- Seeded 4 sample reports:
  - Weekly Executive Summary (portfolio, weekly Monday 7am, csv, recipients demo@cre.local)
  - Daily Operations - 100 Main Tower (site, daily 7am, manager@cre.local)
  - Monthly Compliance - All Vendors (org, monthly 1st 7am, compliance@cre.local)
  - Occupancy Report (portfolio site, weekly)

**metrics.report_runs**
- History of report executions: `report_id, org_id, status pending|running|completed|failed, file_path (org/reports/report_id/date/name.ext in site-files bucket), file_size, row_count, error_message, started_at, completed_at`
- Realtime enabled

### Views:

**metrics.v_building_benchmark**
- Compares sites within same portfolio on same date (last 30 days):
- Columns: org_id, portfolio_id, portfolio_name, site_id, site_name, city, site_type, sq_ft, date, occupancy_rate, work_orders_open, sla_breaches, compliance_rate, visitor_count, labor_hours, **portfolio_avg_occupancy (avg over partition by portfolio_id, date), portfolio_avg_compliance, portfolio_avg_open_wos, occupancy_rank, compliance_rank (rank() over partition)**
- Frontend: benchmarking table shows site vs portfolio avg, green if above avg, rank 1..N
- Security invoker enabled (RLS via underlying tables)

**metrics.v_asset_health_rollup**
- Per site: total_assets, active_assets, maintenance_assets, overdue_maintenance (next_maintenance_at < now), warranty_expired, unhealthy_assets (health_status != healthy from v_asset_health), health_score % healthy, open_wos_for_assets

**metrics.v_sla_metrics**
- Per site per day: total_wos, breached (sla_due_at < completed_at or null and < now), overdue, avg_hours_to_complete, avg_sla_hours, urgent_count, high_count
- For SLA dashboard: breach rate trend

### Functions:

**rollup_daily_stats_enhanced(date)**
- Enhanced rollup described above + calls rollup_portfolio_daily_stats
- Replaces old rollup_daily_stats (old function now calls enhanced for backward compat)

**rollup_portfolio_daily_stats(date)**
- Aggregates daily_site_stats to portfolio level

**get_site_kpis(site_id)**
- Returns jsonb: site_id, date (latest), occupancy_rate, compliance_rate, work_orders_open, sla_breach_rate (sla_breaches/(open+closed)*100), visitor_today, labor_hours_7d sum last 7 days, asset_health_score (healthy/total*100), avg_response_time
- RLS: checks can_access_site, GraphQL query: getSiteKPIs

**get_portfolio_kpis(portfolio_id)**
- Returns org, portfolio_id, date, total_sites, total_sq_ft, occupancy_rate, compliance_rate, work_orders_open, sla_breaches_7d sum, labor_hours_7d
- RLS: is_org_member

### Edge Functions:

**scheduled-reports** - Scheduled daily 7am via config.toml + pg_cron

- POST `{report_id?}` or from cron with no body (processes due reports where next_run_at <= now)
- For each due report (limit 20):
  - Create report_runs pending -> running
  - Based on report.type:
    - daily_ops/weekly_exec: query daily_site_stats last 7 or 30 days, filter by site_id if set, build CSV headers date,site_name,occupancy_rate,work_orders_open,closed,sla_breaches,compliance_rate,visitor_count,labor_hours
    - compliance: query v_compliance_dashboard filtered by org_id limit 500
    - occupancy: query spaces leasable
    - else: daily_site_stats limited
  - Generate file content csv/json based on format, upload to `site-files/{org_id}/reports/{report_id}/{date}/{safeName}-{date}.csv/.json` with contentType, upsert true
  - Create signed URL 7 days
  - Update reports last_run_at now, next_run_at +7 days or +1 day based on cron
  - Update report_runs completed with file_path, file_size, row_count
  - If Resend key + recipients array → email via Resend API with summary + download button linking signed URL
  - Returns results array with report_id, status, file_path, url, row_count, email_sent
- If no due reports: returns "No due reports"

**export-data** - Generic Export (for Data Export capability)

- POST `{table: "work_orders"|"assets"|"inspections"|... , site_id?, org_id?, format: csv|json, date_from?, date_to?, filters: {}, limit: 1000}` with Authorization: Bearer user JWT (RLS enforced)
- Allowed tables: work_orders, assets, inspections, incidents, service_requests, reservations, visits, access_logs, vendors, contracts, cois, compliance_status, daily_site_stats, spaces, leases (map to schemas via TABLE_SCHEMA_MAP)
- Builds query with schema.table, .eq filters, .gte/.lte created_at, limit min(limit,5000), uses user's JWT so RLS applies
- If format json: returns {count, table, data}
- If csv: builds headers from all keys seen, escapes commas/quotes, returns CSV with Content-Disposition attachment
- Frontend: Data Export page - dropdown table, date pickers, site selector, Export button calls this function

### Crons (No new crons needed for analytics, but enhanced rollup already runs 3am daily via existing job)

- Existing `rollup-daily-metrics` 3am now calls enhanced version (via old function wrapper) → both daily_site_stats and portfolio_daily_stats
- scheduled-reports 7am daily via config.toml (also can be triggered via pg_cron with net.http_post if needed)

### GraphQL Examples:

```graphql
# Site KPIs (exec dashboard card)
query SiteKPIs($siteId: UUID!) {
  metricsGetSiteKpis(pSiteId: $siteId)
}

# Portfolio KPIs
query PortfolioKPIs($portfolioId: UUID!) {
  metricsGetPortfolioKpis(pPortfolioId: $portfolioId)
}

# Daily site stats history (for charts)
query SiteStats($siteId: UUID!) {
  metricsDailySiteStatsCollection(
    filter: {siteId: {eq: $siteId}}
    orderBy: {date: AscNullsLast}
    first: 30
  ) {
    edges { node {
      date occupancyRate complianceRate workOrdersOpen workOrdersClosed slaBreaches visitorCount laborHours
    } }
  }
}

# Portfolio stats
query PortfolioStats($portfolioId: UUID!) {
  metricsPortfolioDailyStatsCollection(
    filter: {portfolioId: {eq: $portfolioId}}
    orderBy: {date: DescNullsLast}
    first: 30
  ) {
    edges { node {
      date totalSites totalSqFt occupancyRate complianceRate workOrdersOpen slaBreaches visitorCount
    } }
  }
}

# Benchmarking
query Benchmark($portfolioId: UUID!) {
  metricsVBuildingBenchmarkCollection(
    filter: {portfolioId: {eq: $portfolioId}}
    orderBy: {date: DescNullsLast}
  ) {
    edges { node {
      siteId siteName city occupancyRate complianceRate workOrdersOpen portfolioAvgOccupancy portfolioAvgCompliance occupancyRank complianceRank
    } }
  }
}

# SLA metrics
query SLA($siteId: UUID!) {
  metricsVSlaMetricsCollection(
    filter: {siteId: {eq: $siteId}}
    orderBy: {date: DescNullsLast}
    first: 30
  ) {
    edges { node { date totalWos breached overdue avgHoursToComplete urgentCount } }
  }
}

# Reports
query Reports($orgId: UUID!) {
  metricsReportsCollection(filter: {orgId: {eq: $orgId}}) {
    edges { node {
      id name type format scheduleCron status lastRunAt nextRunAt recipients
      metricsReportRunsCollection(orderBy: {createdAt: DescNullsLast}, first: 5) {
        edges { node { status filePath rowCount startedAt completedAt } }
      }
    } }
  }
}

mutation CreateReport($orgId: UUID!, $name: String!) {
  insertIntoMetricsReportsCollection(objects: [{
    orgId: $orgId, name: $name, type: weekly_exec, format: csv, scheduleCron: "0 7 * * 1", recipients: ["manager@example.com"]
  }]) {
    records { id name }
  }
}
```

### Testing Phase 4:

```sql
-- KPIs
select metrics.create_default_kpis((select id from platform.organizations where slug='demo-cre'));

-- Rollup enhanced
select metrics.rollup_daily_stats_enhanced(current_date - 1);
select metrics.rollup_portfolio_daily_stats(current_date - 1);

-- KPIs
select metrics.get_site_kpis((select id from portfolio.sites limit 1));
select metrics.get_portfolio_kpis((select id from portfolio.portfolios limit 1));

-- Benchmark
select * from metrics.v_building_benchmark limit 5;

-- Asset health rollup
select * from metrics.v_asset_health_rollup;

-- SLA metrics
select * from metrics.v_sla_metrics order by date desc limit 5;

-- Reports
select * from metrics.reports;
```

### Frontend Unlocked - Final Dashboards:

**Executive Dashboard (Portfolio Manager):**
- Top KPI cards: Occupancy Rate, Compliance Rate, Open WOs, SLA Breach 7d, Visitor 7d, Labor 7d
- Portfolio chart: occupancy_rate over last 30 days (line chart from portfolio_daily_stats)
- Benchmark table: Sites ranked by occupancy/compliance vs portfolio avg, color-coded
- Asset health: donut healthy vs overdue

**Operational Dashboard (Site Manager):**
- Site KPI cards: get_site_kpis
- Work orders: open/closed/breached trend (daily_site_stats)
- Inspections: completed/failed
- Incidents open
- Low stock alert from ops.check_low_stock()
- Visitor today vs yesterday

**Reports Page:**
- List reports with next_run_at, last_run, recipients
- Create new report form: name, type, format, schedule cron (daily/weekly/monthly picker generates cron), recipients emails, filters
- Run now button → calls scheduled-reports function with report_id
- History: report_runs with file_path signed URL download + row count

**Data Export:**
- Dropdown: table (work_orders, assets, etc), site, date range, format
- Export button calls export-data function with JWT, returns CSV download

---

## All 5 Domains Complete!

Your CRE SaaS now has:

1. ✅ **Building Operations** (Phase 1): Assets, Work Orders, PM, Checklists, Inspections, Inventory, Labor, Incidents, Engineering Reports
2. ✅ **Tenant Experience** (Phase 2A): Tenants, Service Requests, Reservations, Amenities, Announcements, Events, Feedback
3. ✅ **Visitor Management** (Phase 2B): Visitors, Passes, QR, Access Devices, Kiosk, Blacklist, Access Logs
4. ✅ **Compliance & Vendor** (Phase 3): Vendors, Contracts, COIs, OCR, Rules Engine, Dashboard, Notification Rules
5. ✅ **Portfolio & Analytics** (Phase 4): Daily/Portfolio Stats, KPIs, Benchmarking, Scheduled Reports, Data Export

**Shared Platform:** Auth, RBAC (owner, admin, portfolio_manager, site_manager, engineer, security...), Audit Logs, Notifications, Storage (7 buckets), Search (trigram), Realtime, GraphQL, Scheduler (pg_cron 10 jobs)

**Total:** 15 migrations (~6,500 lines SQL), 11 Edge Functions, 7 storage buckets, 10 cron jobs, full RLS, GraphQL mutations/queries, Realtime subscriptions
