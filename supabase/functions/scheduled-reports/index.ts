// scheduled-reports - Runs scheduled reports defined in metrics.reports
// Called by pg_cron daily, or manually, generates CSV/JSON/PDF and emails recipients

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const resendKey = Deno.env.get('RESEND_API_KEY')
  const supabase = createClient(supabaseUrl, serviceRole)

  try {
    const body = await req.json().catch(() => ({}))
    const reportIdFilter = body.report_id || null

    // Find due reports: next_run_at <= now and status active, or specific report_id
    let query = supabase.schema('metrics').from('reports').select('*').eq('status', 'active')

    if (reportIdFilter) {
      query = query.eq('id', reportIdFilter)
    } else {
      query = query.lte('next_run_at', new Date().toISOString())
    }

    const { data: dueReports, error } = await query.limit(20)
    if (error) throw error

    if (!dueReports || dueReports.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: 'No due reports', count: 0 }), { headers: { 'Content-Type': 'application/json' } })
    }

    const results: any[] = []

    for (const report of dueReports) {
      const runId = crypto.randomUUID()
      let filePath: string | null = null
      let fileSize = 0
      let rowCount = 0

      try {
        // Create run entry pending
        await supabase.schema('metrics').from('report_runs').insert({
          id: runId,
          report_id: report.id,
          org_id: report.org_id,
          status: 'running',
          started_at: new Date().toISOString()
        })

        // Determine data source based on report type
        let csvContent = ''
        let jsonData: any = {}

        if (report.type === 'daily_ops' || report.type === 'weekly_exec') {
          // Get daily_site_stats for last 7 or 30 days
          const days = report.type === 'daily_ops' ? 7 : 30
          const { data: stats } = await supabase.schema('metrics').from('daily_site_stats')
            .select('*, sites!inner(name)')
            .eq('org_id', report.org_id)
            .gte('date', new Date(Date.now() - days * 86400000).toISOString().split('T')[0])
            .order('date', { ascending: false })
            .limit(500)

          if (report.site_id) {
            const filtered = stats?.filter((s: any) => s.site_id === report.site_id)
            jsonData = { stats: filtered, summary: { total: filtered?.length } }
          } else {
            jsonData = { stats, summary: { total: stats?.length } }
          }

          // CSV header
          const headers = ['date','site_name','occupancy_rate','work_orders_open','work_orders_closed','sla_breaches','compliance_rate','visitor_count','labor_hours']
          const rows = (jsonData.stats || []).map((s: any) => [
            s.date,
            `"${(s.sites?.name || s.site_id || '').replace(/"/g,'""')}"`,
            s.occupancy_rate || '',
            s.work_orders_open || 0,
            s.work_orders_closed || 0,
            s.sla_breaches || 0,
            s.compliance_rate || '',
            s.visitor_count || 0,
            s.labor_hours || 0
          ].join(','))
          csvContent = [headers.join(','), ...rows].join('\n')
          rowCount = rows.length

        } else if (report.type === 'compliance') {
          // Use compliance dashboard view
          const { data: complianceData } = await supabase.schema('vendor').from('v_compliance_dashboard')
            .select('*')
            .eq('org_id', report.org_id)
            .limit(500)

          jsonData = { compliance: complianceData }
          const headers = ['vendor_name','vendor_type','site_name','compliance_status','active_contracts','valid_cois','expiring_cois','expired_cois','next_expiry_date']
          const rows = (complianceData || []).map((d: any) => [
            `"${(d.vendor_name||'').replace(/"/g,'""')}"`,
            d.vendor_type,
            `"${(d.site_name||'').replace(/"/g,'""')}"`,
            d.compliance_status,
            d.active_contracts,
            d.valid_cois,
            d.expiring_cois,
            d.expired_cois,
            d.next_expiry_date || ''
          ].join(','))
          csvContent = [headers.join(','), ...rows].join('\n')
          rowCount = rows.length

        } else if (report.type === 'occupancy') {
          const { data: spaces } = await supabase.schema('portfolio').from('spaces')
            .select('id, name, code, type, status, area_sq_ft, site_id, sites!inner(name)')
            .eq('org_id', report.org_id)
            .eq('type', 'leasable')
            .limit(1000)

          jsonData = { spaces }
          const headers = ['site_name','space_name','code','status','area_sq_ft']
          const rows = (spaces || []).map((s: any) => [
            `"${(s.sites?.name||'').replace(/"/g,'""')}"`,
            `"${s.name.replace(/"/g,'""')}"`,
            s.code || '',
            s.status,
            s.area_sq_ft || ''
          ].join(','))
          csvContent = [headers.join(','), ...rows].join('\n')
          rowCount = rows.length

        } else {
          // Generic: use report.filters to determine? For now return daily_site_stats
          const { data: stats } = await supabase.schema('metrics').from('daily_site_stats')
            .select('*')
            .eq('org_id', report.org_id)
            .order('date', { ascending: false })
            .limit(200)
          jsonData = { stats, filters: report.filters }
          csvContent = JSON.stringify(stats, null, 2)
          rowCount = stats?.length || 0
        }

        // Determine file content based on format
        let fileContent: string | Uint8Array = csvContent
        let contentType = 'text/csv'
        let ext = 'csv'

        if (report.format === 'json') {
          fileContent = JSON.stringify(jsonData, null, 2)
          contentType = 'application/json'
          ext = 'json'
        } else if (report.format === 'pdf') {
          // For MVP, we generate CSV and call it PDF? In production use jsPDF
          // Here we still generate CSV but name .pdf placeholder
          contentType = 'application/pdf'
          ext = 'csv' // still csv for now
        }

        // Upload to storage: org_id/reports/report_id/date/report-name.ext
        const dateStr = new Date().toISOString().split('T')[0]
        const safeName = report.name.replace(/[^a-zA-Z0-9_-]/g, '_')
        filePath = `${report.org_id}/reports/${report.id}/${dateStr}/${safeName}-${dateStr}.${ext}`
        fileSize = fileContent.length

        const { error: uploadError } = await supabase.storage.from('site-files').upload(filePath, fileContent, {
          contentType,
          upsert: true
        })

        if (uploadError) throw uploadError

        const { data: urlData } = await supabase.storage.from('site-files').createSignedUrl(filePath, 3600*24*7)

        // Update report last_run and next_run (simple: +7 days if weekly, +1 day if daily, else +7)
        const nextRun = new Date()
        if (report.schedule_cron.includes('0 7 * * 1')) { // weekly Monday
          nextRun.setDate(nextRun.getDate() + 7)
        } else if (report.schedule_cron.startsWith('0 7 * * *')) { // daily
          nextRun.setDate(nextRun.getDate() + 1)
        } else {
          nextRun.setDate(nextRun.getDate() + 7)
        }

        await supabase.schema('metrics').from('reports').update({
          last_run_at: new Date().toISOString(),
          next_run_at: nextRun.toISOString()
        }).eq('id', report.id)

        // Update run as completed
        await supabase.schema('metrics').from('report_runs').update({
          status: 'completed',
          file_path: filePath,
          file_size: fileSize,
          row_count: rowCount,
          completed_at: new Date().toISOString()
        }).eq('id', runId)

        // Send email if Resend configured and recipients
        let emailSent = false
        if (resendKey && report.recipients && report.recipients.length > 0) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${resendKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'PlutusPM Reports <reports@your-domain.com>',
                to: report.recipients,
                subject: `${report.name} - ${dateStr}`,
                html: `
                  <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
                    <h2>${report.name}</h2>
                    <p>Your scheduled report is ready.</p>
                    <p><strong>Type:</strong> ${report.type}<br/>
                    <strong>Date:</strong> ${dateStr}<br/>
                    <strong>Rows:</strong> ${rowCount}</p>
                    ${urlData?.signedUrl ? `<p><a href="${urlData.signedUrl}" style="background:#0f172a;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Download Report (${ext.toUpperCase()})</a></p><p style="color:#64748b;font-size:12px">Link expires in 7 days</p>` : ''}
                    <p style="color:#64748b;font-size:12px">This is automated report from PlutusPM platform.</p>
                  </div>
                `
              })
            })
            emailSent = true
          } catch (e) {
            console.error('Email failed', e)
          }
        }

        results.push({ report_id: report.id, name: report.name, status: 'completed', file_path: filePath, url: (await supabase.storage.from('site-files').createSignedUrl(filePath, 3600*24*7)).data?.signedUrl, row_count: rowCount, email_sent: emailSent })

      } catch (e: any) {
        console.error(`Report ${report.id} failed`, e)
        await supabase.schema('metrics').from('report_runs').update({
          status: 'failed',
          error_message: e.message,
          completed_at: new Date().toISOString()
        }).eq('id', runId)

        results.push({ report_id: report.id, name: report.name, status: 'failed', error: e.message })
      }
    }

    return new Response(JSON.stringify({ ok: true, processed: results.length, results }), { headers: { 'Content-Type': 'application/json' } })

  } catch (e: any) {
    console.error(e)
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
