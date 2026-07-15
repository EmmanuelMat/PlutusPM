# Phase 2 - Tenant Experience + Visitor Management - Complete

**Status:** Built, migrations 00009 + 00010 + 00011 + 2 new Edge Functions  
**Domains:** Tenant Experience + Visitor Management (full)

---

## Phase 2A: Tenant Experience Full

### What was scaffolded before vs now:

| Before (Phase 0) | Now (Phase 2) |
|------------------|---------------|
| tenants basic | + logo, industry, primary_contact, tenant_contacts junction with roles |
| service_requests | + notify status trigger, + feedback |
| reservations basic | + amenities table, + conflict check, + approval flow |

### New Tables:

**tenant.tenant_contacts**
- Junction: many profiles can belong to a tenant company
- `tenant_id, profile_id, role: primary|admin|member|billing|facility, is_primary`
- RLS: can_access_site

**tenant.announcements**
- `site_id, building_id, title, body, audience: all|tenants|staff|tenant_specific|building_specific, priority: low|normal|high|urgent, publish_at, expires_at, is_published, image_url, attachment_paths`
- Managers create, all org members can view if can_access_site
- Realtime enabled → frontend gets live announcement feed

**tenant.events**
- `site_id, title, description, location_text, space_id, start_at, end_at, capacity, is_public, requires_rsvp`
- `tenant.event_rsvps` (event_id, profile_id, status: going|interested|not_going|waitlist)

**tenant.amenities**
- Extends `portfolio.spaces` where type=amenity: `space_id unique, category: conference_room|meeting_room|gym|rooftop|lounge|parking|event_space, capacity, hourly_rate, is_bookable, booking_rules jsonb: {min_hours, max_hours, advance_days, requires_approval}`
- Seed: Conference Room A, meeting rooms, parking from existing amenity spaces

**Enhancements to reservations:**
- Adds `amenity_id, approved_by, approval_status: pending|approved|denied`
- Function `check_reservation_conflict(space_id, start, end, exclude_id)` → boolean using `tstzrange &&`
- Function `create_reservation(site_id, space_id, start, end, title, attendees)` → checks conflict + creates + notification
- Edge Function `amenity-booking`: POST `action: check_conflict|create` with JWT for RLS, calls those functions

**tenant.feedback**
- `profile_id, type: service_request|work_order|amenity|event|general|complaint|suggestion, related_id, rating 1-5, comment, is_anonymous`
- Users create own, managers view all

**GraphQL Examples:**

```graphql
# Announcements feed
query Announcements($siteId: UUID!) {
  tenantAnnouncementsCollection(
    filter: {siteId: {eq: $siteId}, isPublished: {eq: true}}
    orderBy: {publishAt: DescNullsLast}
  ) {
    edges { node { id title body priority audience publishAt imageUrl } }
  }
}

# Events with RSVP
query Events($siteId: UUID!) {
  tenantEventsCollection(filter: {siteId: {eq: $siteId}}, orderBy: {startAt: AscNullsLast}) {
    edges { node {
      id title startAt endAt locationText capacity
      tenantEventRsvpsCollection { edges { node { status profileId } } }
    } }
  }
}

mutation RSVP($eventId: UUID!) {
  tenantEventRsvpsCollection: insertIntoTenantEventRsvpsCollection(objects: [{eventId: $eventId, status: going}]) {
    records { id status }
  }
}

# Amenities + reservations
query Amenities($siteId: UUID!) {
  tenantAmenitiesCollection(filter: {siteId: {eq: $siteId}, isBookable: {eq: true}}) {
    edges { node {
      id name category capacity hourlyRate bookingRules
      portfolioSpaces { name code }
    } }
  }
}

# Check conflict before booking
query CheckConflict($spaceId: UUID!, $start: Datetime!, $end: Datetime!) {
  tenantCheckReservationConflict(pSpaceId: $spaceId, pStart: $start, pEnd: $end)
}

mutation Book($siteId: UUID!, $spaceId: UUID!, $start: Datetime!, $end: Datetime!) {
  tenantCreateReservation(input: {pSiteId: $siteId, pSpaceId: $spaceId, pStart: $start, pEnd: $end, pTitle: "Team Meeting"}) {
    id title startTime endTime status approvalStatus
  }
}

# Feedback
mutation Feedback($siteId: UUID!, $type: String!, $rating: Int!, $comment: String!) {
  insertIntoTenantFeedbackCollection(objects: [{siteId: $siteId, type: $type, rating: $rating, comment: $comment}]) {
    records { id rating }
  }
}
```

---

## Phase 2B: Visitor Management Full

### New Tables:

**visitor.passes**
- Separate from visits (visits QR was simple, passes have lifecycle)
- `qr_token unique, type: day|multi_day|recurring|contractor|vip, status: active|used|expired|revoked|pending, valid_from, valid_until, max_uses, used_count, issued_by, revoked_at`
- Index on token + site + validity for fast kiosk scan
- Function `generate_pass_for_visit(visit_id, valid_until, type)` → checks blacklist, creates pass, updates visit.qr_code

**visitor.access_devices**
- Smart locks, turnstiles, kiosks: `site_id, building_id, name: "Main Lobby Turnstile 1", device_type: turnstile|door_lock|gate|elevator|parking_gate|kiosk, identifier (MAC/serial), access_point, is_online, is_active, last_seen_at, metadata: {ip, vendor}`
- Seed: 4 devices (turnstile, kiosk, parking gate, elevator)

**visitor.access_credentials**
- NFC, Bluetooth, mobile: `user_id OR visitor_id, type: nfc|bluetooth|qr|pin|mobile|card, credential_id unique per org, expires_at, is_active`
- For staff/tenants who have permanent badge

**visitor.blacklist**
- Watchlist: `visitor_id or email, reason, severity: low|medium|high|critical, added_by, expires_at, is_active`
- Security/Managers only
- Checked in `generate_pass_for_visit` and `validate_pass`

**Enhanced visits:**
- Adds `pass_id, checked_in_by, checked_out_by, host_notified_at, nda_signed, visitor_company_verified`

### Functions & Flow:

**Visitor Registration Flow (full):**

1. Tenant preregisters: `registerVisitor(site_id, name, email, purpose, host_user_id, scheduled_at)` → creates visitors (upsert by email) + visits (preregistered) with qr_code

2. Generate pass: `generate_pass_for_visit(visit_id, valid_until, type)` → checks blacklist, creates `passes` with qr_token, updates visit.pass_id

3. Send pass email: Call Edge Function `send-visitor-pass` POST `{visit_id}` → sends Resend email with QR image + host notification

4. Kiosk scan:
   - Validate: `validate_pass(token)` → returns visitor name, company, status, valid_until, is_blacklisted, host_name (for lobby display without check-in)
   - Check-in: `check_in_visitor(token, device_id, checked_in_by)` → validates pass not expired/max_uses, checks blacklist again, updates visit.status=checked_in, checked_in_at, increments pass.used_count, logs to `access_logs` (granted), notifies host via `notifications` + sets host_notified_at
   - Check-out: `check_out_visitor(visit_id, device_id)` → status=checked_out, log

5. Security dashboard stats: `get_daily_visitor_stats(site_id, date)` → preregistered, checked_in, checked_out, no_show, denied counts

**Access Logs:**
- `visitor.access_logs` already existed, now enhanced: every check-in/out inserts log with device_id, access_point, event granted/denied, timestamp
- Trigger expiration: cron `expire-visitor-passes` hourly → passes valid_until < now → status expired, visits preregistered scheduled_at < now-2h → no_show

**Edge Function `visitor-kiosk`:**
- Public (verify_jwt false for kiosk device) CORS enabled
- POST `{action, token|visit_id, device_id}`
  - `validate` → calls `validate_pass`
  - `check_in` → `check_in_visitor`
  - `check_out` → `check_out_visitor`
  - `stats` → `get_daily_visitor_stats` + today's visits list (for dashboard)

Frontend kiosk can be simple HTML page hitting this function.

**GraphQL Examples:**

```graphql
# Register visitor (existing from Phase 0)
mutation Register($siteId: UUID!, $name: String!, $email: String!) {
  visitorRegisterVisitor(input: {pSiteId: $siteId, pName: $name, pEmail: $email}) {
    id qrCode status scheduledAt
  }
}

# Generate pass
mutation GenPass($visitId: UUID!) {
  visitorGeneratePassForVisit(input: {pVisitId: $visitId}) {
    id qrToken type validFrom validUntil status
  }
}

# Validate before check-in (kiosk display)
query Validate($token: String!) {
  visitorValidatePass(pToken: $token) {
    visitId visitorName visitorCompany status validUntil isBlacklisted hostName
  }
}

# Check-in
mutation CheckIn($token: String!, $deviceId: UUID) {
  visitorCheckInVisitor(input: {pToken: $token, pDeviceId: $deviceId}) {
    id status checkedInAt hostUserId
  }
}

# Today's stats
query Stats($siteId: UUID!) {
  visitorGetDailyVisitorStats(pSiteId: $siteId) {
    totalPreregistered checkedIn checkedOut noShow denied
  }
  visitorVisitsCollection(filter: {siteId: {eq: $siteId}}, orderBy: {scheduledAt: AscNullsLast}) {
    edges { node {
      id status scheduledAt checkedInAt
      visitorVisitors { fullName company }
      visitorPasses { qrToken status }
    } }
  }
}

# Access logs
query Logs($siteId: UUID!) {
  visitorAccessLogsCollection(filter: {siteId: {eq: $siteId}}, orderBy: {timestamp: DescNullsLast}, first: 20) {
    edges { node { deviceId accessPoint event timestamp visitId } }
  }
}

# Blacklist (security only)
query Blacklist($orgId: UUID!) {
  visitorBlacklistCollection(filter: {orgId: {eq: $orgId}, isActive: {eq: true}}) {
    edges { node { email fullName reason severity expiresAt } }
  }
}
```

### Security Dashboard Capabilities Now Possible:

- Live visitor count (Realtime on visits + access_logs)
- Turnstile device status (access_devices.is_online)
- Blacklist check on generate_pass + validate_pass (blocks entry)
- Host notifications via platform.notifications Realtime

---

## Seed Data (00011)

If demo org/site exists:

- **Announcements:** 3 (Welcome portal, Elevator maintenance high priority, Holiday party)
- **Events:** 2 (Yoga in park, Town Hall) 
- **Amenities:** Auto from existing amenity spaces → Conference Room A, meeting rooms, parking
- **Reservations:** 2 sample bookings (Weekly Team Meeting, Client Presentation)
- **Visitors:** 3 (Alice, Bob, Carol) + 2 preregistered visits + passes + pass_id linkage
- **Access Devices:** 4 (Turnstile, Kiosk, Parking Gate, Elevator)
- **Tenant Contacts:** Link demo profile to tenant company as primary

---

## Frontend Tasks Unlocked:

**Tenant Portal:**
- Announcements feed (Realtime) + Events + RSVP
- Amenities gallery + booking calendar (check conflict before booking, call amenity-booking edge function)
- My reservations + cancel
- Service request rating (feedback)
- Directory: tenant_contacts list for site

**Visitor Kiosk (lobby iPad):**
- Simple page: camera scans QR → calls visitor-kiosk function validate → shows visitor photo/name + host + blacklist warning → Check-in button → calls check_in + prints badge (via generate-qr function) + notifies host
- Security view: today's visitor stats + live logs via Realtime on access_logs + visitor list with status colors
- Host view (tenant): My visitors today + expected arrival

---

## Testing Phase 2

```sql
-- Announcements
select * from tenant.announcements where site_id = (select id from portfolio.sites limit 1);

-- Check reservation conflict (should be false initially)
select tenant.check_reservation_conflict(
  (select id from portfolio.spaces where site_id = (select id from portfolio.sites limit 1) limit 1),
  now() + interval '1 day', 
  now() + interval '1 day' + interval '1 hour'
);

-- Create reservation
select tenant.create_reservation(
  (select id from portfolio.sites limit 1),
  (select id from portfolio.spaces limit 1),
  now() + interval '1 day' + interval '9 hours',
  now() + interval '1 day' + interval '10 hours',
  'Test Meeting'
);

-- Now conflict should be true
select tenant.check_reservation_conflict(
  (select id from portfolio.spaces limit 1),
  now() + interval '1 day' + interval '9 hours' + interval '30 minutes',
  now() + interval '1 day' + interval '10 hours' + interval '30 minutes'
);

-- Visitor flow
select * from visitor.visitors limit 3;
select * from visitor.visits where status='preregistered' limit 2;
select * from visitor.passes limit 2;

-- Generate pass
select visitor.generate_pass_for_visit((select id from visitor.visits limit 1));

-- Validate
select * from visitor.validate_pass((select qr_token from visitor.passes limit 1));

-- Check-in
select visitor.check_in_visitor((select qr_token from visitor.passes limit 1));

-- Stats
select * from visitor.get_daily_visitor_stats((select id from portfolio.sites limit 1), current_date);

-- Access logs
select * from visitor.access_logs order by timestamp desc limit 5;
```

---

## Next: Phase 3 Compliance & Vendor + Phase 4 Analytics still to build

Phase 3 will add:
- Full contract lifecycle + approval workflow
- COI OCR parsing edge function (parse-coi-pdf)
- Compliance rules engine + dashboard materialized view

Phase 4:
- Executive dashboards, KPI aggregation per portfolio, benchmarking, scheduled reports
