-- 00011_phase2_seed.sql
-- Seed Phase 2 Tenant + Visitor data

do $$
declare
  demo_org_id uuid;
  demo_site_id uuid;
  tenant_id uuid;
  profile_id uuid;
  amenity_id uuid;
  space_id uuid;
  visitor_id uuid;
  device_id uuid;
begin
  select id into demo_org_id from platform.organizations where slug='demo-cre' limit 1;
  if demo_org_id is null then raise notice 'No demo org'; return; end if;

  select id into demo_site_id from portfolio.sites where org_id=demo_org_id limit 1;
  if demo_site_id is null then raise notice 'No demo site'; return; end if;

  select id into profile_id from platform.profiles limit 1;

  -- Get tenant
  select id into tenant_id from tenant.tenants where org_id=demo_org_id limit 1;
  if tenant_id is not null then
    -- Tenant contacts
    if profile_id is not null and not exists (select 1 from tenant.tenant_contacts where tenant_id=tenant_id and profile_id=profile_id) then
      insert into tenant.tenant_contacts (tenant_id, profile_id, org_id, site_id, role, is_primary)
      values (tenant_id, profile_id, demo_org_id, demo_site_id, 'primary', true);
    end if;
  end if;

  -- Announcements
  if not exists (select 1 from tenant.announcements where org_id=demo_org_id limit 1) then
    insert into tenant.announcements (org_id, site_id, title, body, audience, priority, is_published, publish_at, created_by)
    values
      (demo_org_id, demo_site_id, 'Welcome to PlutusPM Portal', 'This is your new tenant portal. Manage service requests, reserve amenities, and stay updated with building news.', 'all', 'normal', true, now(), profile_id),
      (demo_org_id, demo_site_id, 'Elevator Maintenance - Sat 6am-10am', 'Elevator A will be under maintenance this Saturday 6am-10am. Please use Elevator B.', 'all', 'high', true, now() - interval '1 day', profile_id),
      (demo_org_id, demo_site_id, 'Holiday Party - Rooftop Dec 15', 'Join us for our annual holiday party on the rooftop. Catering, drinks, and live music!', 'tenants', 'normal', true, now(), profile_id);
  end if;

  -- Events
  if not exists (select 1 from tenant.events where org_id=demo_org_id limit 1) then
    insert into tenant.events (org_id, site_id, title, description, location_text, start_at, end_at, capacity, is_public, requires_rsvp)
    values
      (demo_org_id, demo_site_id, 'Yoga in the Park', 'Free yoga class in the courtyard', 'Courtyard', now() + interval '3 days', now() + interval '3 days' + interval '1 hour', 30, true, true),
      (demo_org_id, demo_site_id, 'Tenant Town Hall', 'Quarterly town hall with building management', 'Conference Room A', now() + interval '7 days', now() + interval '7 days' + interval '1 hour', 50, true, true);
  end if;

  -- Amenities (from spaces)
  select id into space_id from portfolio.spaces where site_id=demo_site_id and type='amenity' limit 1;
  if space_id is not null and not exists (select 1 from tenant.amenities where space_id=space_id) then
    insert into tenant.amenities (org_id, site_id, space_id, name, description, category, capacity, is_bookable, booking_rules)
    values
      (demo_org_id, demo_site_id, space_id, 'Conference Room A', '10 person conference room with projector', 'conference_room', 10, true, '{"min_hours":1,"max_hours":4,"advance_days":30}'::jsonb);

    -- Try to find other amenity spaces
    for space_id in select id from portfolio.spaces where site_id=demo_site_id and type='amenity' and id != space_id limit 3 loop
      insert into tenant.amenities (org_id, site_id, space_id, name, category, capacity, is_bookable)
      values (demo_org_id, demo_site_id, space_id, (select name from portfolio.spaces where id=space_id), 'meeting_room', 6, true)
      on conflict (space_id) do nothing;
    end loop;
  end if;

  -- For parking amenity if exists
  select id into space_id from portfolio.spaces where site_id=demo_site_id and type='parking' limit 1;
  if space_id is not null and not exists (select 1 from tenant.amenities where space_id=space_id) then
    insert into tenant.amenities (org_id, site_id, space_id, name, category, capacity, is_bookable)
    values (demo_org_id, demo_site_id, space_id, 'Visitor Parking', 'parking', 20, true)
    on conflict (space_id) do nothing;
  end if;

  -- Visitors & Visits
  if not exists (select 1 from visitor.visitors where org_id=demo_org_id limit 1) then
    insert into visitor.visitors (org_id, full_name, email, company, phone)
    values
      (demo_org_id, 'Alice Johnson', 'alice@acme.example.com', 'Acme Tech', '+1-555-0101'),
      (demo_org_id, 'Bob Smith', 'bob@contractor.example.com', 'HVAC Pros', '+1-555-0102'),
      (demo_org_id, 'Carol Davis', 'carol@client.example.com', 'Client Co', '+1-555-0103')
    returning id into visitor_id;

    -- Visits
    insert into visitor.visits (org_id, site_id, visitor_id, host_user_id, purpose, status, scheduled_at, qr_code)
    select demo_org_id, demo_site_id, v.id, profile_id, 'Business Meeting', 'preregistered', now() + interval '1 day', 'V-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
    from visitor.visitors v where v.org_id=demo_org_id limit 2;

    -- Passes for visits
    insert into visitor.passes (org_id, site_id, visit_id, visitor_id, qr_token, type, status, valid_from, valid_until, issued_by)
    select org_id, site_id, id, visitor_id, qr_code, 'day'::visitor.pass_type, 'active'::visitor.pass_status, now(), now() + interval '1 day', profile_id
    from visitor.visits where org_id=demo_org_id limit 2;

    -- Update visits with pass_id
    update visitor.visits vi set pass_id = p.id from visitor.passes p where p.visit_id = vi.id and vi.pass_id is null;
  end if;

  -- Access devices
  if not exists (select 1 from visitor.access_devices where org_id=demo_org_id limit 1) then
    insert into visitor.access_devices (org_id, site_id, name, device_type, access_point, identifier, is_active, is_online)
    values
      (demo_org_id, demo_site_id, 'Main Lobby Turnstile 1', 'turnstile', 'Main Lobby', 'TURN-001', true, true),
      (demo_org_id, demo_site_id, 'Lobby Kiosk', 'kiosk', 'Main Lobby', 'KIOSK-001', true, true),
      (demo_org_id, demo_site_id, 'Parking Gate North', 'parking_gate', 'North Parking', 'GATE-N-01', true, true),
      (demo_org_id, demo_site_id, 'Elevator Bank A', 'elevator', 'Lobby', 'ELEV-A', true, false);
  end if;

  -- Sample reservations
  select id into amenity_id from tenant.amenities where org_id=demo_org_id limit 1;
  if amenity_id is not null and profile_id is not null and not exists (select 1 from tenant.reservations where org_id=demo_org_id limit 1) then
    -- Get space_id for amenity
    select space_id into space_id from tenant.amenities where id=amenity_id;
    if space_id is not null then
      insert into tenant.reservations (org_id, site_id, space_id, amenity_id, reserved_by, title, start_time, end_time, status, approval_status, attendees)
      values
        (demo_org_id, demo_site_id, space_id, amenity_id, profile_id, 'Weekly Team Meeting', now() + interval '1 day' + interval '9 hours', now() + interval '1 day' + interval '10 hours', 'confirmed', 'approved', 8),
        (demo_org_id, demo_site_id, space_id, amenity_id, profile_id, 'Client Presentation', now() + interval '2 days' + interval '14 hours', now() + interval '2 days' + interval '15 hours', 'confirmed', 'approved', 12);
    end if;
  end if;

  raise notice 'Phase 2 seed completed for org % site %', demo_org_id, demo_site_id;
end $$;

-- Summary
select 'Announcements' as tbl, count(*) from tenant.announcements
union all select 'Events', count(*) from tenant.events
union all select 'Amenities', count(*) from tenant.amenities
union all select 'Visitors', count(*) from visitor.visitors
union all select 'Visits', count(*) from visitor.visits
union all select 'Passes', count(*) from visitor.passes
union all select 'Access Devices', count(*) from visitor.access_devices
union all select 'Reservations', count(*) from tenant.reservations;
