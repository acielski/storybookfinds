-- After creating both app users in this wedding Supabase project:
-- Replace OWNER_EMAIL and PARTNER_EMAIL below. Run as admin in SQL Editor.
do $$
declare wedding_owner uuid;partner uuid;
begin
 select id into wedding_owner from auth.users where lower(email)=lower('OWNER_EMAIL');
 select id into partner from auth.users where lower(email)=lower('PARTNER_EMAIL');
 if wedding_owner is null or partner is null then raise exception 'Create both wedding app accounts first and check their emails.';end if;
 if wedding_owner=partner then raise exception 'Use two different users.';end if;
 if exists(select 1 from public.wedding_members where member_id=wedding_owner or member_id=partner or owner_id=partner) then raise exception 'Review existing wedding memberships before assigning this person.';end if;
 insert into public.wedding_members(member_id,owner_id,role) values(partner,wedding_owner,'editor');
end;
$$;
