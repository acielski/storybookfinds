-- Run once in Supabase SQL Editor. No credentials belong in this file.
create table if not exists public.workspaces (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.workspaces enable row level security;
revoke all on public.workspaces from anon;
grant select, insert, update on public.workspaces to authenticated;
drop policy if exists "Users read their own workspace" on public.workspaces;
create policy "Users read their own workspace" on public.workspaces for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "Users create their own workspace" on public.workspaces;
create policy "Users create their own workspace" on public.workspaces for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "Users update their own workspace" on public.workspaces;
create policy "Users update their own workspace" on public.workspaces for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

-- Atomic compare-and-swap prevents simultaneous requests overwriting imports.
-- Security invoker: the caller's own JWT and row-level policies apply.
create or replace function public.save_workspace(expected_version integer, new_state jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare saved_version integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if expected_version < 0 or jsonb_typeof(new_state) <> 'object' then
    raise exception 'Invalid workspace state';
  end if;
  if expected_version = 0 then
    insert into public.workspaces(owner_id,version,state)
    values(auth.uid(),1,new_state)
    on conflict (owner_id) do nothing returning version into saved_version;
  else
    update public.workspaces set state=new_state, version=version+1, updated_at=now()
    where owner_id=auth.uid() and version=expected_version
    returning version into saved_version;
  end if;
  return saved_version;
end;
$$;
revoke all on function public.save_workspace(integer,jsonb) from public, anon;
grant execute on function public.save_workspace(integer,jsonb) to authenticated;
