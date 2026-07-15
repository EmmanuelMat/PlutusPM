-- 00016_graphql_fix.sql
-- Fix GraphQL Unknown field errors like "Unknown field portfolioPortfoliosCollection on type Query"
-- Root causes:
-- 1. No inflect_names comment on custom schemas -> field names remain snake_case or not camelCase as expected
-- 2. Missing grants for anon role in some tables (pg_graphql filters by role)
-- 3. GraphQL schema not rebuilt after migrations
-- 4. Schemas not in extra_search_path for PostgREST/GraphQL introspection

-- Enable inflect_names for all custom schemas (converts snake_case to camelCase for GraphQL)
-- Without this, field names might be like portfolio_portfolios_collection instead of portfolioPortfoliosCollection
comment on schema public is '@graphql({"inflect_names": true})';
comment on schema platform is '@graphql({"inflect_names": true})';
comment on schema portfolio is '@graphql({"inflect_names": true})';
comment on schema ops is '@graphql({"inflect_names": true})';
comment on schema tenant is '@graphql({"inflect_names": true})';
comment on schema visitor is '@graphql({"inflect_names": true})';
comment on schema vendor is '@graphql({"inflect_names": true})';
comment on schema metrics is '@graphql({"inflect_names": true})';

-- Ensure usage grants for anon, authenticated, service_role on all custom schemas (required for GraphQL visibility)
grant usage on schema platform to anon, authenticated, service_role;
grant usage on schema portfolio to anon, authenticated, service_role;
grant usage on schema ops to anon, authenticated, service_role;
grant usage on schema tenant to anon, authenticated, service_role;
grant usage on schema visitor to anon, authenticated, service_role;
grant usage on schema vendor to anon, authenticated, service_role;
grant usage on schema metrics to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Ensure SELECT granted to both anon and authenticated for GraphQL introspection
-- Previously we only granted to authenticated for most tables, but GraphQL needs explicit grants
-- The breaking change in Supabase (April 2026) requires explicit GRANTs for tables to be exposed

-- Platform
grant select on all tables in schema platform to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema platform to authenticated, service_role;

-- Portfolio (core)
grant select on all tables in schema portfolio to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema portfolio to authenticated, service_role;

-- Ops
grant select on all tables in schema ops to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema ops to authenticated, service_role;

-- Tenant
grant select on all tables in schema tenant to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema tenant to authenticated, service_role;

-- Visitor
grant select on all tables in schema visitor to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema visitor to authenticated, service_role;

-- Vendor
grant select on all tables in schema vendor to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema vendor to authenticated, service_role;

-- Metrics
grant select on all tables in schema metrics to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema metrics to authenticated, service_role;

-- Public (for any public tables)
grant select on all tables in schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;

-- Grant usage on sequences for anon too (needed for inserts)
grant usage on all sequences in schema platform to anon, authenticated, service_role;
grant usage on all sequences in schema portfolio to anon, authenticated, service_role;
grant usage on all sequences in schema ops to anon, authenticated, service_role;
grant usage on all sequences in schema tenant to anon, authenticated, service_role;
grant usage on all sequences in schema visitor to anon, authenticated, service_role;
grant usage on all sequences in schema vendor to anon, authenticated, service_role;
grant usage on all sequences in schema metrics to anon, authenticated, service_role;
grant usage on all sequences in schema public to anon, authenticated, service_role;

-- Rebuild GraphQL schema (if function exists - in newer pg_graphql it auto-rebuilds)
do $$
begin
  perform graphql.rebuild_schema();
  raise notice 'graphql.rebuild_schema() executed successfully';
exception when undefined_function then
  raise notice 'graphql.rebuild_schema() not found - newer pg_graphql auto-rebuilds on DDL, skipping';
when others then
  raise notice 'graphql.rebuild_schema() failed: %, skipping', SQLERRM;
end;
$$;

-- Reload PostgREST schema cache
do $$
begin
  notify pgrst, 'reload config';
  notify pgrst, 'reload schema';
  raise notice 'Notified pgrst to reload config and schema';
exception when others then
  raise notice 'Failed to notify pgrst: %', SQLERRM;
end;
$$;

-- Create a helper view to debug GraphQL visibility
create or replace view public.graphql_debug_tables as
select 
  schemaname,
  tablename,
  has_table_privilege('anon', schemaname||'.'||tablename, 'select') as anon_can_select,
  has_table_privilege('authenticated', schemaname||'.'||tablename, 'select') as auth_can_select,
  has_schema_privilege('anon', schemaname, 'usage') as anon_schema_usage,
  has_schema_privilege('authenticated', schemaname, 'usage') as auth_schema_usage
from pg_tables
where schemaname in ('platform','portfolio','ops','tenant','visitor','vendor','metrics','public')
order by schemaname, tablename;

grant select on public.graphql_debug_tables to anon, authenticated, service_role;
