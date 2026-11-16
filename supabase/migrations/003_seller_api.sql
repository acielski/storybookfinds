-- Run AFTER 001_workspace.sql and 002_shared_workspaces.sql.
-- Existing financial workspaces are preserved. No API tokens belong in these tables.
create table if not exists public.seller_resources (
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_-]{0,63}$'),
  resource_id text not null check (length(resource_id) between 1 and 512),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  updated_at timestamptz not null default now(),
  primary key (owner_id,kind,resource_id)
);
create table if not exists public.seller_metadata (
  owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (length(key) between 1 and 128),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id,key)
);
create table if not exists public.seller_locks (
  owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (length(key) between 1 and 128),
  lease_token text not null,
  expires_at timestamptz not null,
  primary key (owner_id,key)
);

alter table public.seller_resources enable row level security;
alter table public.seller_metadata enable row level security;
alter table public.seller_locks enable row level security;
revoke all on public.seller_resources,public.seller_metadata,public.seller_locks from public,anon,authenticated;
grant select,insert,update,delete on public.seller_resources,public.seller_metadata,public.seller_locks to authenticated,service_role;
-- The scheduled worker uses explicit owner filters and optimistic versions when
-- updating the legacy financial workspace. No browser receives this credential.
grant select,insert,update on public.workspaces to service_role;

-- These security-invoker policies reuse immediate membership revocation from 002.
drop policy if exists "Shop members read seller resources" on public.seller_resources;
create policy "Shop members read seller resources" on public.seller_resources for select to authenticated
using (owner_id=(select public.current_workspace_owner()));
drop policy if exists "Shop editors insert seller resources" on public.seller_resources;
create policy "Shop editors insert seller resources" on public.seller_resources for insert to authenticated
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));
drop policy if exists "Shop editors update seller resources" on public.seller_resources;
create policy "Shop editors update seller resources" on public.seller_resources for update to authenticated
using (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()))
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));
drop policy if exists "Shop editors delete seller resources" on public.seller_resources;
create policy "Shop editors delete seller resources" on public.seller_resources for delete to authenticated
using (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));

drop policy if exists "Shop members read seller metadata" on public.seller_metadata;
create policy "Shop members read seller metadata" on public.seller_metadata for select to authenticated
using (owner_id=(select public.current_workspace_owner()));
drop policy if exists "Shop editors insert seller metadata" on public.seller_metadata;
create policy "Shop editors insert seller metadata" on public.seller_metadata for insert to authenticated
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));
drop policy if exists "Shop editors update seller metadata" on public.seller_metadata;
create policy "Shop editors update seller metadata" on public.seller_metadata for update to authenticated
using (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()))
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));
drop policy if exists "Shop editors delete seller metadata" on public.seller_metadata;
create policy "Shop editors delete seller metadata" on public.seller_metadata for delete to authenticated
using (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));

drop policy if exists "Shop members read seller locks" on public.seller_locks;
create policy "Shop members read seller locks" on public.seller_locks for select to authenticated
using (owner_id=(select public.current_workspace_owner()));
drop policy if exists "Shop editors insert seller locks" on public.seller_locks;
create policy "Shop editors insert seller locks" on public.seller_locks for insert to authenticated
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));
drop policy if exists "Shop editors update seller locks" on public.seller_locks;
create policy "Shop editors update seller locks" on public.seller_locks for update to authenticated
using (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()))
with check (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));
drop policy if exists "Shop editors delete seller locks" on public.seller_locks;
create policy "Shop editors delete seller locks" on public.seller_locks for delete to authenticated
using (owner_id=(select public.current_workspace_owner()) and (select public.can_edit_workspace()));

-- A lease protects one bounded sync step or label request across server instances.
-- Callers retain RLS permissions; worker callers use a server-only service role.
create or replace function public.seller_claim_lock(p_owner_id uuid,p_key text,p_token text,p_ttl_seconds integer default 90)
returns text language plpgsql security invoker set search_path='' as $$
declare acquired text;
begin
  if p_ttl_seconds is null or p_ttl_seconds<1 or p_ttl_seconds>300 or p_token is null or length(p_token)<1 or length(p_token)>512 then
    raise exception 'Invalid seller operation lease';
  end if;
  insert into public.seller_locks(owner_id,key,lease_token,expires_at)
    values(p_owner_id,p_key,p_token,now()+p_ttl_seconds*interval '1 second')
  on conflict(owner_id,key) do update set lease_token=excluded.lease_token,expires_at=excluded.expires_at
    where public.seller_locks.expires_at<=now()
  returning lease_token into acquired;
  return acquired;
end;
$$;
create or replace function public.seller_release_lock(p_owner_id uuid,p_key text,p_token text)
returns void language sql security invoker set search_path='' as $$
  delete from public.seller_locks where owner_id=p_owner_id and key=p_key and lease_token=p_token;
$$;
revoke all on function public.seller_claim_lock(uuid,text,text,integer),public.seller_release_lock(uuid,text,text) from public,anon;
grant execute on function public.seller_claim_lock(uuid,text,text,integer),public.seller_release_lock(uuid,text,text) to authenticated,service_role;
