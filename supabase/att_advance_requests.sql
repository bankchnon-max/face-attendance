-- Migration att_advance_requests: salary-advance requests made at the kiosk (face-verified, always pending); only HR approves.
-- Approving creates the att_pay_items 'advance' line (deducted in the pay period of its day) in the same transaction.
create table public.att_advance_requests (
  id text primary key default gen_random_uuid()::text,
  emp_id text not null,
  amount numeric(10,2) not null check (amount > 0 and amount < 1000000),
  reason text check (char_length(reason) <= 200),
  snap text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 200),
  approved_amount numeric(10,2) check (approved_amount is null or (approved_amount > 0 and approved_amount < 1000000)),
  pay_item_id uuid
);
create index att_advance_requests_status_idx on public.att_advance_requests (status) where status = 'pending';
create index att_advance_requests_time_idx on public.att_advance_requests (requested_at);
alter table public.att_advance_requests enable row level security;
revoke all on public.att_advance_requests from anon;
create policy att_adv_read on public.att_advance_requests for select to authenticated using ((select att_private.is_hr()));
create policy att_adv_insert on public.att_advance_requests for insert to authenticated with check (
  (select att_private.is_hr())
  or ((select att_private.is_staff()) and status = 'pending' and decided_by is null and decided_at is null
      and decision_note is null and approved_amount is null and pay_item_id is null));
create policy att_adv_update on public.att_advance_requests for update to authenticated using ((select att_private.is_hr())) with check ((select att_private.is_hr()));
create policy att_adv_delete on public.att_advance_requests for delete to authenticated using ((select att_private.is_hr()));
alter publication supabase_realtime add table public.att_advance_requests;

-- HR decides; approving inserts the pay item (day = the request day in Thailand unless HR gives one)
create or replace function public.att_decide_advance(p_id text, p_approve boolean, p_amount numeric default null, p_day date default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.att_advance_requests; it public.att_pay_items;
begin
  if not att_private.is_hr() then raise exception 'เฉพาะ HR เท่านั้น'; end if;
  select * into r from public.att_advance_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอนี้'; end if;
  if r.status <> 'pending' then raise exception 'คำขอนี้ตัดสินไปแล้ว'; end if;
  if p_approve then
    insert into public.att_pay_items (emp_id, day, kind, amount, note, created_by)
      values (r.emp_id, coalesce(p_day, (r.requested_at at time zone 'Asia/Bangkok')::date), 'advance', coalesce(p_amount, r.amount),
              left('ขอเบิกที่เครื่องสแกน' || coalesce(' · ' || nullif(r.reason, ''), ''), 200), auth.uid())
      returning * into it;
    update public.att_advance_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(),
      decision_note = nullif(p_note, ''), approved_amount = it.amount, pay_item_id = it.id where id = p_id;
    return to_jsonb(it);
  end if;
  update public.att_advance_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(p_note, '') where id = p_id;
  return null;
end $$;
revoke execute on function public.att_decide_advance(text, boolean, numeric, date, text) from public, anon;
grant execute on function public.att_decide_advance(text, boolean, numeric, date, text) to authenticated;
