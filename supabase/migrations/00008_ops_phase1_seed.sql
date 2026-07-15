-- 00008_ops_phase1_seed.sql
-- Seed checklists, inventory, sample inspections for Phase 1 demo

do $$
declare
  demo_org_id uuid;
  demo_site_id uuid;
  checklist_id uuid;
  item_id uuid;
  inventory_cat_id uuid;
  item_hvac_filter uuid;
  item_elev_belt uuid;
  asset_id uuid;
begin
  select id into demo_org_id from platform.organizations where slug='demo-cre' limit 1;
  if demo_org_id is null then raise notice 'No demo org, skipping Phase 1 seed'; return; end if;

  select id into demo_site_id from portfolio.sites where org_id=demo_org_id limit 1;
  if demo_site_id is null then raise notice 'No demo site'; return; end if;

  -- Checklists
  if not exists (select 1 from ops.checklists where org_id=demo_org_id and name='Monthly HVAC Inspection' and site_id is not null) then
    insert into ops.checklists (org_id, site_id, name, description, category, estimated_minutes, is_active)
    values (demo_org_id, demo_site_id, 'Monthly HVAC Inspection - Detailed', 'Full HVAC system check per manufacturer specs', 'hvac', 60, true)
    returning id into checklist_id;

    -- Items
    insert into ops.checklist_items (checklist_id, sort_order, label, description, item_type, is_required, expected_value)
    values
      (checklist_id, 1, 'Check air filters', 'Inspect filters for dirt, replace if >50% clogged', 'pass_fail', true, '{"pass":["Pass","Yes"],"fail":["Fail"]}'::jsonb),
      (checklist_id, 2, 'Check refrigerant levels', 'Level should be within manufacturer spec', 'numeric', true, '{"min": 10, "max": 15}'::jsonb),
      (checklist_id, 3, 'Inspect belts and pulleys', 'Check for wear, tension', 'pass_fail', true, null),
      (checklist_id, 4, 'Check thermostat calibration', 'Compare setpoint vs actual temp', 'numeric', false, null),
      (checklist_id, 5, 'Take photo of unit', 'Photo for record', 'photo', true, null),
      (checklist_id, 6, 'Overall condition', 'Rate overall condition', 'multiple_choice', true, '["Good","Fair","Poor","Critical"]'::jsonb)
    returning id into item_id;

    -- Second checklist: Fire Safety
    insert into ops.checklists (org_id, site_id, name, description, category, estimated_minutes, is_active)
    values (demo_org_id, demo_site_id, 'Weekly Fire Safety Check', 'Fire extinguishers, alarms, emergency lights', 'fire_safety', 30, true)
    returning id into checklist_id;

    insert into ops.checklist_items (checklist_id, sort_order, label, item_type, is_required)
    values
      (checklist_id, 1, 'Fire extinguishers charged and accessible', 'pass_fail', true),
      (checklist_id, 2, 'Emergency lights functional', 'pass_fail', true),
      (checklist_id, 3, 'Fire alarm panel shows no faults', 'pass_fail', true),
      (checklist_id, 4, 'Sprinkler system pressure normal', 'numeric', true),
      (checklist_id, 5, 'Exit signs illuminated', 'pass_fail', true);
  end if;

  -- Inventory categories & items
  select id into inventory_cat_id from ops.inventory_categories where org_id=demo_org_id and name='HVAC Parts' limit 1;
  if inventory_cat_id is null then
    insert into ops.inventory_categories (org_id, name)
    values (demo_org_id, 'HVAC Parts'), (demo_org_id, 'Electrical'), (demo_org_id, 'Plumbing'), (demo_org_id, 'Safety'), (demo_org_id, 'General')
    returning id into inventory_cat_id;
  end if;

  if not exists (select 1 from ops.inventory_items where org_id=demo_org_id and sku='FILTER-MERV13-20x25') then
    insert into ops.inventory_items (org_id, category_id, name, sku, description, unit, cost_per_unit, min_stock_level)
    values
      (demo_org_id, inventory_cat_id, 'Air Filter MERV13 20x25x4', 'FILTER-MERV13-20x25', 'High efficiency air filter for air handling units', 'each', 45.50, 10),
      (demo_org_id, inventory_cat_id, 'Belt - Fan Drive 50 inch', 'BELT-FAN-50', 'Drive belt for supply fan', 'each', 22.00, 5),
      (demo_org_id, inventory_cat_id, 'Refrigerant R-410A 25lb', 'REF-R410A-25', 'Refrigerant', 'tank', 180.00, 2),
      (demo_org_id, (select id from ops.inventory_categories where org_id=demo_org_id and name='Electrical'), 'LED Panel 2x4 40W', 'LED-2X4-40W', 'Office LED panel', 'each', 65.00, 20),
      (demo_org_id, (select id from ops.inventory_categories where org_id=demo_org_id and name='Safety'), 'Fire Extinguisher ABC 10lb', 'FIRE-EXT-10LB', 'ABC fire extinguisher', 'each', 95.00, 8)
    returning id into item_hvac_filter;

    -- Stock for demo site
    insert into ops.inventory_stock (org_id, site_id, inventory_item_id, quantity, location)
    select demo_org_id, demo_site_id, id, case when sku like 'FILTER%' then 3 else 15 end, 'Storage Room A'
    from ops.inventory_items where org_id=demo_org_id
    on conflict (site_id, inventory_item_id) do nothing;
  end if;

  -- Sample inspection (draft) for demo asset
  select id into asset_id from ops.assets where site_id=demo_site_id limit 1;
  if asset_id is not null and not exists (select 1 from ops.inspections where asset_id=asset_id limit 1) then
    -- create inspection via function
    perform ops.create_inspection_from_checklist(
      demo_site_id,
      (select id from ops.checklists where org_id=demo_org_id limit 1),
      asset_id,
      'Initial HVAC Inspection - Demo Asset',
      null,
      now()
    );
  end if;

  raise notice 'Phase 1 seed completed for org % site %', demo_org_id, demo_site_id;
end $$;

-- Show counts
select 'Checklists' as tbl, count(*) from ops.checklists
union all select 'Checklist_items', count(*) from ops.checklist_items
union all select 'Inspections', count(*) from ops.inspections
union all select 'Inventory_items', count(*) from ops.inventory_items
union all select 'Inventory_stock', count(*) from ops.inventory_stock;
