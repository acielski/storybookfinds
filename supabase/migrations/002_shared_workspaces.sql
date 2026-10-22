-- Run AFTER 001_workspace.sql. Existing shop data stays in place.
-- Membership is managed by an administrator through Supabase SQL Editor.
create table if not exists public.workspace_members (
  member_id uuid primary key references auth.users(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer','editor')),
  created_at timestamptz not null default now(),
  check (member_id <> owner_id)
);
alter table public.workspace_members enable row level security;
revoke all on public.workspace_members from public, anon, authenticated;
grant select on public.workspace_members to authenticated;
drop policy if exists "Members see their own membership" on public.workspace_members;
create policy "Members see their own membership" on public.workspace_members for select to authenticated
using (member_id=(select auth.uid()) or owner_id=(select auth.uid()));

create or replace function public.current_workspace_owner()
returns uuid language sql stable security invoker set search_path='' as $$
  select coalesce((select m.owner_id from public.workspace_members m where m.member_id=auth.uid()),auth.uid());
$$;
create or replace function public.can_edit_workspace()
returns boolean language sql stable security invoker set search_path='' as $$
  select auth.uid() is not null and coalesce((select m.role='editor' from public.workspace_members m where m.member_id=auth.uid()),true);
$$;
create or replace function public.workspace_context()
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('ownerId',public.current_workspace_owner(),'role',
    coalesce((select m.role from public.workspace_members m where m.member_id=auth.uid()),'owner'));
$$;
revoke all on function public.current_workspace_owner(),public.can_edit_workspace(),public.workspace_context() from public,anon;
grant execute on function public.current_workspace_owner(),public.can_edit_workspace(),public.workspace_context() to authenticated;

revoke all on public.workspaces from public,anon,authenticated;
grant select,insert,update on public.workspaces to authenticated;
drop policy if exists "Users read their own workspace" on public.workspaces;
drop policy if exists "Users create their own workspace" on public.workspaces;
drop policy if exists "Users update their own workspace" on public.workspaces;
drop policy if exists "Shop members read workspace" on public.workspaces;
drop policy if exists "Shop editors create workspace" on public.workspaces;
drop policy if exists "Shop editors update workspace" on public.workspaces;
create policy "Shop members read workspace" on public.workspaces for select to authenticated
using (owner_id=(select public.current_workspace_owner()));
create policy "Shop editors create workspace" on public.workspaces for insert to authenticated
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));
create policy "Shop editors update workspace" on public.workspaces for update to authenticated
using (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()))
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));

create or replace function public.save_workspace(expected_version integer,new_state jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare saved_version integer; target_owner uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.can_edit_workspace() then raise exception 'This shop membership is read-only' using errcode='42501'; end if;
  if expected_version is null or expected_version<0 or new_state is null or jsonb_typeof(new_state)<>'object' then raise exception 'Invalid workspace state'; end if;
  target_owner:=public.current_workspace_owner();
  if expected_version=0 then
    insert into public.workspaces(owner_id,version,state) values(target_owner,1,new_state)
    on conflict(owner_id) do nothing returning version into saved_version;
  else
    update public.workspaces set state=new_state,version=version+1,updated_at=now()
    where owner_id=target_owner and version=expected_version returning version into saved_version;
  end if;
  return saved_version;
end;
$$;
revoke all on function public.save_workspace(integer,jsonb) from public,anon;
grant execute on function public.save_workspace(integer,jsonb) to authenticated;
