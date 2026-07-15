-- 00015_phase4_seed.sql
-- Seed Phase 4: KPI definitions, sample reports, enhanced stats

do $$
declare
  demo_org_id uuid;
  demo_portfolio_id uuid;
  demo_site_id uuid;
  profile_id uuid;
begin
  select id into demo_org_id from platform.organizations where slug='demo-cre' limit 1;
  if demo_org_id is null then raise notice 'No demo org'; return; end if;

  select id into demo_portfolio_id from portfolio.portfolios where org_id=demo_org_id limit 1;
  select id into demo_site_id from portfolio.sites where org_id=demo_org_id limit 1;
  select id into profile_id from platform.profiles limit 1;

  -- Create default KPIs for demo org
  perform metrics.create_default_kpis(demo_org_id);

  -- Enhance daily stats for last 14 days to have more realistic data (if not exists)
  if not exists (select 1 from metrics.daily_site_stats where site_id=demo_site_id and date = current_date - interval '7 days') then
    -- Run enhanced rollup for last 30 days
    for i in 0..14 loop
      perform metrics.rollup_daily_stats_enhanced(current_date - (i || ' days')::interval::date);
    end loop;
  end if;

  -- Sample reports
  if demo_site_id is not null and not exists (select 1 from metrics.reports where org_id=demo_org_id limit 1) then
    insert into metrics.reports (org_id, portfolio_id, site_id, name, description, type, format, schedule_cron, recipients, filters, status, next_run_at, created_by)
    values
      (demo_org_id, demo_portfolio_id, null, 'Weekly Executive Summary', 'High-level KPIs across all sites in Downtown Portfolio', 'weekly_exec', 'csv', '0 7 * * 1', array['demo@cre.local'], '{"include": ["occupancy","compliance","work_orders","visitors"]}'::jsonb, 'active', now() + interval '1 day', profile_id),
      (demo_org_id, demo_portfolio_id, demo_site_id, 'Daily Operations - 100 Main Tower', 'Daily work orders, visitors, incidents for 100 Main Tower', 'daily_ops', 'csv', '0 7 * * *', array['manager@cre.local'], '{"site_id": "100-main-tower"}'::jsonb, 'active', now() + interval '1 day', profile_id),
      (demo_org_id, null, null, 'Monthly Compliance Report - All Vendors', 'Full compliance status for all vendors', 'compliance', 'csv', '0 7 1 * *', array['compliance@cre.local'], '{}'::jsonb, 'active', now() + interval '2 days', profile_id),
      (demo_org_id, demo_portfolio_id, demo_site_id, 'Occupancy Report', 'Leasable spaces occupancy', 'occupancy', 'csv', '0 7 * * 1', array['leasing@cre.local'], '{}'::jsonb, 'active', now() + interval '3 days', profile_id);

    raise notice 'Created sample reports';
  end if;

  raise notice 'Phase 4 seed done for org % portfolio % site %', demo_org_id, demo_portfolio_id, demo_site_id;
end $$;

-- Summary
select 'KPI Definitions' as tbl, count(*) from metrics.kpi_definitions
union all select 'Daily Site Stats', count(*) from metrics.daily_site_stats
union all select 'Portfolio Daily Stats', count(*) from metrics.portfolio_daily_stats
union all select 'Reports', count(*) from metrics.reports
union all select 'Report Runs', count(*) from metrics.report_runs;
