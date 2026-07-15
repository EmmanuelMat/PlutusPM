// export-data - Generic data export for any table filtered by site/org/date range
// POST { table: "work_orders", site_id?, org_id?, format: "csv|json", date_from?, date_to?, filters? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const ALLOWED_TABLES = [
  'work_orders', 'assets', 'inspections', 'incidents', 'service_requests',
  'reservations', 'visits', 'access_logs', 'vendors', 'contracts', 'cois',
  'compliance_status', 'daily_site_stats', 'spaces', 'leases'
]

const TABLE_SCHEMA_MAP: Record<string, string> = {
  work_orders: 'ops',
  assets: 'ops',
  inspections: 'ops',
  incidents: 'ops',
  service_requests: 'tenant',
  reservations: 'tenant',
  visits: 'visitor',
  access_logs: 'visitor',
  vendors: 'vendor',
  contracts: 'vendor',
  cois: 'vendor',
  compliance_status: 'vendor',
  daily_site_stats: 'metrics',
  spaces: 'portfolio',
  leases: 'portfolio'
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405 })
  }

  try {
    const { table, site_id, org_id, format = 'csv', date_from, date_to, filters = {}, limit = 1000 } = await req.json()

    if (!table || !ALLOWED_TABLES.includes(table)) {
      return new Response(JSON.stringify({ error: `table must be one of: ${ALLOWED_TABLES.join(', ')}` }), { status: 400 })
    }

    const schema = TABLE_SCHEMA_MAP[table]
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Authorization header required (user JWT)' }), { status: 401 })

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    })

    // Build query with RLS (uses user's JWT)
    let query: any = supabase.schema(schema).from(table).select('*').limit(Math.min(limit, 5000))

    if (site_id) query = query.eq('site_id', site_id)
    if (org_id) query = query.eq('org_id', org_id)
    if (date_from) query = query.gte('created_at', date_from)
    if (date_to) query = query.lte('created_at', date_to)

    // Apply additional filters from filters object
    for (const [key, value] of Object.entries(filters)) {
      if (value !== null && value !== undefined) {
        query = query.eq(key, value)
      }
    }

    const { data, error } = await query
    if (error) throw error

    if (!data || data.length === 0) {
      return new Response(JSON.stringify({ ok: true, count: 0, message: 'No data found', data: [] }), { headers: { 'Content-Type': 'application/json' } })
    }

    // Format as CSV or JSON
    if (format === 'json') {
      return new Response(JSON.stringify({ ok: true, count: data.length, table, data }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    // CSV
    const allKeys = new Set<string>()
    data.forEach((row: any) => Object.keys(row).forEach(k => allKeys.add(k)))
    const headers = Array.from(allKeys)

    const csvRows = data.map((row: any) => {
      return headers.map(h => {
        const val = row[h]
        if (val === null || val === undefined) return ''
        let str = typeof val === 'object' ? JSON.stringify(val) : String(val)
        // Escape quotes
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          str = `"${str.replace(/"/g, '""')}"`
        }
        return str
      }).join(',')
    })

    const csv = [headers.join(','), ...csvRows].join('\n')

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename=${table}-${new Date().toISOString().split('T')[0]}.csv`
      }
    })

  } catch (e: any) {
    console.error(e)
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
