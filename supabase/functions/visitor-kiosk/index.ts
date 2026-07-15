// visitor-kiosk - Lobby kiosk check-in/out via QR scan
// Supports both QR validation and check-in

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { action, token, visit_id, device_id } = await req.json()

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceRole)

    if (action === 'validate') {
      // Validate QR without check-in - show visitor details
      if (!token) return new Response(JSON.stringify({ error: 'token required' }), { status: 400, headers: corsHeaders })

      const { data, error } = await supabase.schema('visitor').rpc('validate_pass', { p_token: token })
      if (error) throw error

      return new Response(JSON.stringify({ ok: true, data: data?.[0] || null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (action === 'check_in') {
      if (!token) return new Response(JSON.stringify({ error: 'token required' }), { status: 400, headers: corsHeaders })

      const { data, error } = await supabase.schema('visitor').rpc('check_in_visitor', {
        p_token: token,
        p_device_id: device_id || null,
        p_checked_in_by: null
      })

      if (error) throw error

      return new Response(JSON.stringify({ ok: true, visit: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (action === 'check_out') {
      if (!visit_id) return new Response(JSON.stringify({ error: 'visit_id required' }), { status: 400, headers: corsHeaders })

      const { data, error } = await supabase.schema('visitor').rpc('check_out_visitor', {
        p_visit_id: visit_id,
        p_device_id: device_id || null
      })

      if (error) throw error

      return new Response(JSON.stringify({ ok: true, visit: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (action === 'stats') {
      const { site_id, date } = await req.json()
      if (!site_id) return new Response(JSON.stringify({ error: 'site_id required' }), { status: 400, headers: corsHeaders })

      const { data, error } = await supabase.schema('visitor').rpc('get_daily_visitor_stats', {
        p_site_id: site_id,
        p_date: date || new Date().toISOString().split('T')[0]
      })

      if (error) throw error

      // Also get today's visits
      const { data: visits } = await supabase.schema('visitor').from('visits')
        .select('id, status, scheduled_at, checked_in_at, visitors!inner(full_name, company)')
        .eq('site_id', site_id)
        .gte('scheduled_at', new Date().toISOString().split('T')[0])
        .order('scheduled_at', { ascending: true })
        .limit(50)

      return new Response(JSON.stringify({ ok: true, stats: data?.[0] || {}, visits: visits || [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Invalid action. Use validate, check_in, check_out, stats' }), { status: 400, headers: corsHeaders })

  } catch (e: any) {
    console.error(e)
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
