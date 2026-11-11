-- Run in Supabase SQL Editor as an administrator, AFTER migration 002.
-- Replace OWNER_APP_EMAIL and NEW_USER_EMAIL below with the real app login emails.
-- Start with viewer (read-only); use editor only when they should change records.
do $$
declare
  shop_owner uuid;
  new_member uuid;
  requested_role text := 'viewer';
begin
  select id into shop_owner from auth.users where lower(email)=lower('OWNER_APP_EMAIL');
  select id into new_member from auth.users where lower(email)=lower('NEW_USER_EMAIL');
  if shop_owner is null or new_member is null then
    raise exception 'Both emails must exist under Supabase Authentication > Users. Check the emails and create missing users first.';
  end if;
  if shop_owner=new_member then raise exception 'Use two different accounts.'; end if;
  if exists(select 1 from public.workspace_members where member_id=shop_owner) then
    raise exception 'The owner account is already a member of another shop. Use that shop owner instead.';
  end if;
  if exists(select 1 from public.workspace_members where owner_id=new_member) then
    raise exception 'This account already owns a shared shop. Review its memberships before changing it.';
  end if;
  if exists(select 1 from public.workspace_members where member_id=new_member) then
    raise exception 'This user already has a membership. Review it in workspace_members instead of adding another.';
  end if;
  insert into public.workspace_members(member_id,owner_id,role) values(new_member,shop_owner,requested_role);
end;
$$;
