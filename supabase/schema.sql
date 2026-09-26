-- Face attendance app schema (applied to Supabase as migrations
-- att_face_attendance_schema + att_move_is_staff_to_private_schema + att_drop_employee_code + att_roles_hr_and_kiosk + att_split_write_policies_and_snap_retention + att_leaves).
-- Roles: hr = everything; kiosk = read what scanning needs + add scans only.
-- Only users listed in att_staff can read or write anything.

create table public.att_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'hr' check (role in ('hr','kiosk')),
  created_at timestamptz not null default now()
);

create table public.att_employees (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  dept text,
  descriptors jsonb not null default '[]'::jsonb,   -- face embeddings (128 floats each), biometric data
  photo text,                                       -- small jpeg data URL
  consent_at timestamptz,
  created_at timestamptz not null default now()
);

create index att_employees_name_idx on public.att_employees (name);

create table public.att_events (
  id text primary key default gen_random_uuid()::text,
  emp_id text not null,                 -- no FK: history is kept after an employee is removed
  time timestamptz not null,
  type text not null check (type in ('in','out','lunch')),
  score int,
  live boolean not null default false,
  source text not null default 'face' check (source in ('face','manual','hr')),
  snap text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index att_events_time_idx on public.att_events (time);
create index att_events_emp_time_idx on public.att_events (emp_id, time);

create table public.att_calendar (
  day date primary key,
  type text not null check (type in ('work','off')),
  note text
);

create table public.att_settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- helper lives in a schema that is not exposed through the REST API
create schema if not exists att_private;
revoke all on schema att_private from public, anon;
grant usage on schema att_private to authenticated;

create or replace function att_private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.att_staff where user_id = (select auth.uid()));
$$;
revoke execute on function att_private.is_staff() from public, anon;
grant execute on function att_private.is_staff() to authenticated;

alter table public.att_staff enable row level security;
alter table public.att_employees enable row level security;
alter table public.att_events enable row level security;
alter table public.att_calendar enable row level security;
alter table public.att_settings enable row level security;

create policy att_staff_self on public.att_staff for select to authenticated using (user_id = (select auth.uid()));
create or replace function att_private.is_hr()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.att_staff where user_id = (select auth.uid()) and role = 'hr');
$$;
revoke execute on function att_private.is_hr() from public, anon;
grant execute on function att_private.is_hr() to authenticated;

create policy att_employees_read on public.att_employees for select to authenticated using ((select att_private.is_staff()));
create policy att_employees_insert on public.att_employees for insert to authenticated with check ((select att_private.is_hr()));
create policy att_employees_update on public.att_employees for update to authenticated using ((select att_private.is_hr())) with check ((select att_private.is_hr()));
create policy att_employees_delete on public.att_employees for delete to authenticated using ((select att_private.is_hr()));

create policy att_events_read on public.att_events for select to authenticated using (
  (select att_private.is_hr()) or ((select att_private.is_staff()) and time > now() - interval '3 days'));
create policy att_events_insert on public.att_events for insert to authenticated with check (
  (select att_private.is_hr())
  or ((select att_private.is_staff()) and source in ('face','manual')
      and time > now() - interval '14 days' and time < now() + interval '1 hour'));
create policy att_events_update on public.att_events for update to authenticated using ((select att_private.is_hr())) with check ((select att_private.is_hr()));
create policy att_events_delete on public.att_events for delete to authenticated using ((select att_private.is_hr()));

create policy att_calendar_read on public.att_calendar for select to authenticated using ((select att_private.is_staff()));
create policy att_calendar_insert on public.att_calendar for insert to authenticated with check ((select att_private.is_hr()));
create policy att_calendar_update on public.att_calendar for update to authenticated using ((select att_private.is_hr())) with check ((select att_private.is_hr()));
create policy att_calendar_delete on public.att_calendar for delete to authenticated using ((select att_private.is_hr()));
create policy att_settings_read on public.att_settings for select to authenticated using ((select att_private.is_staff()));
create policy att_settings_insert on public.att_settings for insert to authenticated with check ((select att_private.is_hr()));
create policy att_settings_update on public.att_settings for update to authenticated using ((select att_private.is_hr())) with check ((select att_private.is_hr()));
create policy att_settings_delete on public.att_settings for delete to authenticated using ((select att_private.is_hr()));

revoke all on public.att_staff, public.att_employees, public.att_events, public.att_calendar, public.att_settings from anon;

alter publication supabase_realtime add table public.att_events, public.att_employees, public.att_calendar, public.att_settings;

-- keep scan photos for 90 days only (records stay); runs daily 02:30 Thailand time
create extension if not exists pg_cron;
select cron.schedule('att-clear-old-snapshots', '30 19 * * *',
  $$update public.att_events set snap = null where snap is not null and time < now() - interval '90 days'$$);

-- Leave requests: made at the kiosk (face-verified, always pending) or entered by HR; only HR approves.
create table public.att_leaves (
  id text primary key default gen_random_uuid()::text,
  emp_id text not null,
  type text not null check (type in ('sick','personal','vacation','other')),
  start_date date not null,
  end_date date not null,
  part text not null default 'full' check (part in ('full','am','pm')),
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  source text not null default 'kiosk' check (source in ('kiosk','hr')),
  snap text,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  check (end_date >= start_date),
  check (part = 'full' or end_date = start_date),
  check (end_date - start_date <= 60)
);
create index att_leaves_emp_idx on public.att_leaves (emp_id, start_date);
create index att_leaves_status_idx on public.att_leaves (status) where status = 'pending';
alter table public.att_leaves enable row level security;
revoke all on public.att_leaves from anon;
create policy att_leaves_read on public.att_leaves for select to authenticated using ((select att_private.is_hr()));
create policy att_leaves_insert on public.att_leaves for insert to authenticated with check (
  (select att_private.is_hr())
  or ((select att_private.is_staff()) and status = 'pending' and source = 'kiosk'
      and decided_by is null and decided_at is null and decision_note is null
      and start_date >= current_date - 7));
create policy att_leaves_update on public.att_leaves for update to authenticated using ((select att_private.is_hr())) with check ((select att_private.is_hr()));
create policy att_leaves_delete on public.att_leaves for delete to authenticated using ((select att_private.is_hr()));
alter publication supabase_realtime add table public.att_leaves;
