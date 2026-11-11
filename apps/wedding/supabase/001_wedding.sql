-- Ever After wedding app only. Independent of all Storybook Finds tables.
create table if not exists public.wedding_plans(
 owner_id uuid primary key references auth.users(id) on delete cascade,
 version integer not null check(version>0),
 state jsonb not null check(jsonb_typeof(state)='object' and state @> '{"schemaVersion":1}'),
 updated_at timestamptz not null default now()
);
create table if not exists public.wedding_members(
 member_id uuid primary key references auth.users(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 role text not null default 'editor' check(role in ('editor','viewer')),
 check(member_id<>owner_id)
);
alter table public.wedding_plans enable row level security;
alter table public.wedding_members enable row level security;
revoke all on public.wedding_plans,public.wedding_members from public,anon,authenticated;
grant select,insert,update on public.wedding_plans to authenticated;
grant select on public.wedding_members to authenticated;
drop policy if exists "Wedding members see own membership" on public.wedding_members;
create policy "Wedding members see own membership" on public.wedding_members for select to authenticated using(member_id=(select auth.uid()) or owner_id=(select auth.uid()));
create or replace function public.wedding_plan_context() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('ownerId',coalesce((select m.owner_id from public.wedding_members m where m.member_id=auth.uid()),auth.uid()),'role',coalesce((select m.role from public.wedding_members m where m.member_id=auth.uid()),'owner'));
$$;
revoke all on function public.wedding_plan_context() from public,anon;
grant execute on function public.wedding_plan_context() to authenticated;
drop policy if exists "Wedding readers" on public.wedding_plans;
create policy "Wedding readers" on public.wedding_plans for select to authenticated using(owner_id=((select public.wedding_plan_context())->>'ownerId')::uuid);
drop policy if exists "Wedding creators" on public.wedding_plans;
create policy "Wedding creators" on public.wedding_plans for insert to authenticated with check(owner_id=((select public.wedding_plan_context())->>'ownerId')::uuid and ((select public.wedding_plan_context())->>'role') in ('owner','editor'));
drop policy if exists "Wedding editors" on public.wedding_plans;
create policy "Wedding editors" on public.wedding_plans for update to authenticated using(owner_id=((select public.wedding_plan_context())->>'ownerId')::uuid and ((select public.wedding_plan_context())->>'role') in ('owner','editor')) with check(owner_id=((select public.wedding_plan_context())->>'ownerId')::uuid and ((select public.wedding_plan_context())->>'role') in ('owner','editor'));
create or replace function public.save_wedding_plan(expected_version integer,new_state jsonb) returns integer language plpgsql security invoker set search_path='' as $$
declare context jsonb;target uuid;saved integer;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501';end if;
 context:=public.wedding_plan_context();target:=(context->>'ownerId')::uuid;
 if context->>'role' not in ('owner','editor') then raise exception 'This wedding plan is view only' using errcode='42501';end if;
 if expected_version is null or expected_version<0 or new_state is null or jsonb_typeof(new_state)<>'object' or not (new_state @> '{"schemaVersion":1}') then raise exception 'Invalid wedding plan';end if;
 if expected_version=0 then
  insert into public.wedding_plans(owner_id,version,state) values(target,1,new_state) on conflict(owner_id) do nothing returning version into saved;
 else
  update public.wedding_plans set state=new_state,version=version+1,updated_at=now() where owner_id=target and version=expected_version returning version into saved;
 end if;
 return saved;
end;
$$;
revoke all on function public.save_wedding_plan(integer,jsonb) from public,anon;
grant execute on function public.save_wedding_plan(integer,jsonb) to authenticated;
