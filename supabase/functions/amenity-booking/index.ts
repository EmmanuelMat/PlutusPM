// amenity-booking - handles reservation with conflict check + approval flow + notifications

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })
  }

  try {
    const { site_id, space_id, start_time, end_time, title, attendees = 1, action = 'create' } = await req.json()

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Authorization required' }), { status: 401 })

    // Create client with user's JWT for RLS
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    })

    if (action === 'check_conflict') {
      if (!space_id || !start_time || !end_time) {
        return new Response(JSON.stringify({ error: 'space_id, start_time, end_time required' }), { status: 400 })
      }

      const { data, error } = await supabase.schema('tenant').rpc('check_reservation_conflict', {
        p_space_id: space_id,
        p_start: start_time,
        p_end: end_time
      })

      if (error) throw error

      return new Response(JSON.stringify({ has_conflict: data, available: !data }), { headers: { 'Content-Type': 'application/json' } })
    }

    if (action === 'create') {
      if (!site_id || !space_id || !start_time || !end_time) {
        return new Response(JSON.stringify({ error: 'site_id, space_id, start_time, end_time required' }), { status: 400 })
      }

      const { data, error } = await supabase.schema('tenant').rpc('create_reservation', {
        p_site_id: site_id,
        p_space_id: space_id,
        p_start: start_time,
        p_end: end_time,
        p_title: title || 'Reservation',
        p_attendees: attendees
      })

      if (error) throw error

      return new Response(JSON.stringify({ ok: true, reservation: data }), { headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 })

  } catch (e: any) {
    console.error(e)
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
