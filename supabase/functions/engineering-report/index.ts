// engineering-report - Generates daily engineering report for a site
// POST { site_id: uuid, date?: YYYY-MM-DD } -> PDF or JSON report

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST with { site_id }' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const { site_id, date = new Date().toISOString().split('T')[0], format = 'json' } = await req.json()
    if (!site_id) return new Response(JSON.stringify({ error: 'site_id required' }), { status: 400 })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceRole)

    // Fetch site
    const { data: site } = await supabase.schema('portfolio').from('sites').select('id, name, address_line1, city').eq('id', site_id).single()
    if (!site) return new Response(JSON.stringify({ error: 'Site not found' }), { status: 404 })

    // Work orders for date or open
    const { data: workOrders } = await supabase.schema('ops').from('work_orders')
      .select('id, title, status, priority, type, assigned_to, created_at, completed_at, sla_due_at')
      .eq('site_id', site_id)
      .order('created_at', { ascending: false })
      .limit(50)

    const { data: inspections } = await supabase.schema('ops').from('inspections')
      .select('id, title, status, score, scheduled_at, completed_at')
      .eq('site_id', site_id)
      .order('scheduled_at', { ascending: false })
      .limit(50)

    const { data: incidents } = await supabase.schema('ops').from('incidents')
      .select('id, title, severity, status, occurred_at')
      .eq('site_id', site_id)
      .order('occurred_at', { ascending: false })
      .limit(20)

    const { data: assets } = await supabase.schema('ops').from('assets')
      .select('id, name, status, criticality')
      .eq('site_id', site_id)
      .limit(100)

    // Low stock
    const { data: lowStock } = await supabase.schema('ops').from('inventory_stock')
      .select('quantity, site_id, inventory_items!inner(name, sku, min_stock_level)')
      .eq('site_id', site_id)
      .lte('quantity', 5)

    const report = {
      site,
      date,
      generated_at: new Date().toISOString(),
      summary: {
        open_work_orders: workOrders?.filter((wo: any) => ['open','in_progress','overdue'].includes(wo.status)).length || 0,
        completed_today: workOrders?.filter((wo: any) => wo.completed_at && wo.completed_at.startsWith(date)).length || 0,
        overdue: workOrders?.filter((wo: any) => wo.status === 'overdue').length || 0,
        inspections_due: inspections?.filter((i: any) => i.status === 'draft' || i.status === 'in_progress').length || 0,
        incidents_open: incidents?.filter((i: any) => ['reported','investigating'].includes(i.status)).length || 0,
        assets_total: assets?.length || 0,
        low_stock_count: lowStock?.length || 0
      },
      work_orders: workOrders || [],
      inspections: inspections || [],
      incidents: incidents || [],
      low_stock: lowStock || []
    }

    // If format pdf requested, you could generate PDF via jsPDF (omitted for brevity, return json)
    // Store report to storage optionally
    const reportPath = `${site_id}/${date}/engineering-report-${date}.json`
    // Try upload JSON
    try {
      const { data: orgIdData } = await supabase.schema('portfolio').from('sites').select('org_id').eq('id', site_id).single()
      const orgId = (orgIdData as any)?.org_id
      if (orgId) {
        await supabase.storage.from('site-files').upload(`${orgId}/${reportPath}`, JSON.stringify(report, null, 2), {
          contentType: 'application/json',
          upsert: true
        })
      }
    } catch {}

    return new Response(JSON.stringify(report, null, 2), { headers: { 'Content-Type': 'application/json' } })

  } catch (e: any) {
    console.error(e)
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
