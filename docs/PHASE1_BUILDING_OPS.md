# Phase 1 - Building Operations - Complete

**Status:** Built, migrations 00007 + 00008 + new Edge Function

## What's New vs Phase 0

Phase 0 had basic assets + work_orders. Phase 1 adds **full ops domain**.

### 1. Asset Hierarchy & History

- `ops.assets.parent_asset_id` → tree (chiller → pump → valve)
- `location_description` + `qr_code_last_printed_at`
- `ops.asset_maintenance_history` — explicit history (inspection, preventive, corrective, install, decommission)
  - Used for asset timeline + health view
  - Auto-populated when inspection completed or via work order completion

### 2. Digital Checklists & Inspections (Core of Building Ops)

**Checklists** are templates:

```sql
ops.checklists (id, org_id, site_id, name, category, version, estimated_minutes)
ops.checklist_items (checklist_id, label, item_type: pass_fail|yes_no|numeric|text|photo|signature|multiple_choice, is_required, options jsonb, expected_value jsonb)
```

Example: "Monthly HVAC Inspection" with 6 items (pass/fail, numeric, photo, etc)

**Inspections** are instances:

```sql
ops.inspections (site_id, asset_id, checklist_id, title, status: draft|in_progress|completed|failed, score 0-100, assigned_to, scheduled_at, completed_at)
ops.inspection_items (inspection_id, checklist_item_id, status: pass|fail|na|flagged, response_text, response_numeric, notes, photo_paths text[], scored)
```

**Flow:**

1. Create inspection: `select ops.create_inspection_from_checklist(site_id, checklist_id, asset_id, 'Title')` → auto creates `inspection_items` for each checklist_item with status pending
2. Engineer fills via GraphQL: update `inspection_items` with responses, photos to storage
3. Complete: `select ops.complete_inspection(inspection_id)` → calculates score %, if failed >0 items → auto-creates corrective Work Order + logs to maintenance_history

GraphQL:

```graphql
mutation CreateInspection {
  opsCreateInspectionFromChecklist(input: {
    pSiteId: "uuid", pChecklistId: "uuid", pAssetId: "uuid", pTitle: "Monthly HVAC"
  }) { id title status }
}

query Inspection {
  opsInspectionsCollection(filter: {siteId: {eq: $siteId}}) {
    edges { node {
      id title status score
      opsChecklists { name }
      opsAssets { name }
      opsInspectionItemsCollection {
        edges { node {
          status responseText notes isFlagged
          opsChecklistItems { label itemType }
        } }
      }
    } }
  }
}

mutation Complete {
  opsCompleteInspection(input: {pInspectionId: "uuid"}) { id status score }
}
```

### 3. Work Order Enhancements

- `ops.work_order_comments` — timeline chat (internal vs public)
- `ops.work_order_attachments` — `storage_path = org/site/work_orders/wo_id/file`

Comments Realtime: subscribe to `work_order_comments` for live chat.

### 4. Inventory & Parts Management

```sql
ops.inventory_categories (org_id, name)
ops.inventory_items (org_id, sku unique, name, unit, cost_per_unit, min_stock_level)
ops.inventory_stock (site_id, inventory_item_id unique, quantity, location) -> quantity per site
ops.stock_transactions (site_id, inventory_item_id, stock_id, work_order_id, type: in|out|adjustment|transfer|return, quantity, reason)
```

**Flow:**

- Define part: "Air Filter MERV13" sku FILTER-MERV13, min 10
- Stock: Site A has 3 (below min!) 
- Transaction: When WO uses part, insert `out` transaction + trigger updates `inventory_stock.quantity`
- Cron `check-low-stock` daily 8am queries `ops.check_low_stock()` view → notification + Slack

GraphQL low stock:

```graphql
query LowStock($siteId: UUID!) {
  opsInventoryStockCollection(filter: {siteId: {eq: $siteId}, quantity: {lte: 5}}) {
    edges { node {
      quantity
      opsInventoryItems { name sku minStockLevel }
    } }
  }
}
```

### 5. Labor Tracking

```sql
ops.labor_logs (work_order_id, user_id, hours, rate, total_cost generated as hours*rate, logged_at)
```

Trigger `trg_labor_update_wo` auto-sums hours → `work_orders.labor_hours` + cost.

Frontend: Engineer logs hours after work, dashboard shows cost per site.

### 6. Incident Management

```sql
ops.incidents (site_id, asset_id, work_order_id, title, severity: low|medium|high|critical, status: reported|investigating|resolved|closed|escalated, category: safety|environmental|security|operational, occurred_at, assigned_to)
```

For safety incidents, compliance reporting.

### 7. Views & Reports

- `ops.v_asset_health` view: calculates health_status based on warranty, overdue WO, failed inspections, last maintenance
  - `healthy`, `warranty_expired`, `maintenance_overdue`, `has_overdue_wo`

- Edge Function `engineering-report`: POST `{site_id, date}` → returns JSON report with open WO, completed today, overdue, inspections due, incidents, low stock, stores JSON to `site-files/{org}/{site}/{date}/engineering-report-{date}.json` (can extend to PDF)

### 8. New Cron Jobs

- `check-low-stock` daily 8am → notification per low stock item

Existing crons still run: SLA every 15m, PM generation 2am, COI hourly, metrics 3am, cleanup 4am, lease Mon 9am

### 9. RLS & Realtime

All new tables have RLS via `can_access_site(site_id)` or `is_org_member(org_id)` (for org-wide catalogs like inventory_items). Realtime enabled for inspections, inspection_items, incidents, work_order_comments, inventory_stock.

### 10. Seed Data (00008)

If demo org exists:

- 2 detailed checklists: "Monthly HVAC Inspection - Detailed" (6 items: pass_fail, numeric, photo, multiple_choice) + "Weekly Fire Safety Check"
- 5 inventory categories + 5 items (filters, belts, refrigerant, LEDs, extinguishers) + stock (filter low stock = 3 to test alert)
- 1 draft inspection for demo asset via `create_inspection_from_checklist()`

## Frontend Tasks After Phase 1

Your frontend dev can now build:

1. **Assets Detail Page**:
   - QR code (call `generate-qr` function) + print
   - Hierarchy tree (parent_asset_id)
   - Maintenance history timeline (`getAssetHistory` query)
   - Health status from `v_asset_health`

2. **Checklists Builder**: CRUD checklists + items (org template library)

3. **Inspections Execution**:
   - List assigned inspections
   - Form: for each inspection_item show checklist_item label + input based on item_type (pass/fail buttons, numeric input, photo upload to `work-order-attachments` or `site-files`)
   - Complete button calls `completeInspection` mutation → if fails, show auto-created WO

4. **Work Order Detail Enhanced**:
   - Comments thread (Realtime)
   - Attachments upload
   - Labor log form + total hours/cost display
   - Link to parts used (stock_transactions)

5. **Inventory Management**:
   - Parts catalog (org-wide)
   - Stock per site + low stock alert banner
   - Transaction history

6. **Incidents**:
   - Report incident + assign + track status

7. **Engineering Report**: Daily PDF/JSON via `engineering-report` function

## Testing Phase 1

```sql
-- 1. Check new tables
select * from ops.checklists limit 5;
select * from ops.inventory_items limit 5;

-- 2. Create inspection
select ops.create_inspection_from_checklist(
  (select id from portfolio.sites limit 1),
  (select id from ops.checklists limit 1),
  (select id from ops.assets limit 1),
  'Test HVAC - ' || now()::text
);

-- 3. See inspection items auto-created
select * from ops.inspection_items where inspection_id = (select id from ops.inspections order by created_at desc limit 1);

-- 4. Fail one item and complete
update ops.inspection_items set status='fail', is_flagged=true where inspection_id = (select id from ops.inspections order by created_at desc limit 1) limit 1;
select ops.complete_inspection((select id from ops.inspections order by created_at desc limit 1));

-- Should auto-create WO:
select * from ops.work_orders order by created_at desc limit 1;

-- 5. Low stock
select * from ops.check_low_stock();

-- 6. Asset health
select * from ops.v_asset_health limit 5;

-- 7. Labor
insert into ops.labor_logs (org_id, site_id, work_order_id, user_id, hours, rate, description)
values (
  (select org_id from portfolio.sites limit 1),
  (select id from portfolio.sites limit 1),
  (select id from ops.work_orders limit 1),
  auth.uid(),
  2.5, 75, 'Replaced filter'
);
select labor_hours, cost from ops.work_orders where id = (select id from ops.work_orders limit 1);
```

## GraphQL New Queries

Add to `docs/graphql-examples.md` - see Phase 1 examples above.

## Next Push

After you test locally with `supabase db reset`, I can push this Phase 1 to same GitHub repo main branch.

Want me to push now, or continue to Phase 2 (Tenant + Visitor full)?
