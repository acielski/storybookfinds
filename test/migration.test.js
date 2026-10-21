import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('Supabase migration: real PostgreSQL RLS, per-user saves, and atomic version checks',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon; create role authenticated;
   create schema auth;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema auth to authenticated,anon;
   grant execute on function auth.uid() to authenticated,anon;
   insert into auth.users values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');`);
  const sql=readFileSync(new URL('../supabase/migrations/001_workspace.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql); // Safe to rerun the setup instructions.
  const asUser=async id=>{await db.exec('reset role; set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
  const save=async(version,state)=> (await db.query('select public.save_workspace($1,$2::jsonb) as version',[version,JSON.stringify(state)])).rows[0].version;
  await asUser('11111111-1111-1111-1111-111111111111');assert.equal(await save(0,{test:'owner'}),1);assert.equal(await save(0,{test:'duplicate race'}),null);assert.equal(await save(1,{test:'updated'}),2);assert.equal(await save(1,{test:'stale overwrite'}),null);
  await asUser('22222222-2222-2222-2222-222222222222');assert.equal((await db.query('select * from public.workspaces')).rows.length,0);assert.equal(await save(0,{test:'other'}),1);
  await assert.rejects(db.query("insert into public.workspaces(owner_id,state) values ('11111111-1111-1111-1111-111111111111','{}')"),/row-level security/);
  await assert.rejects(db.query("update public.workspaces set owner_id='11111111-1111-1111-1111-111111111111'"),/row-level security/);
  await asUser('11111111-1111-1111-1111-111111111111');const rows=(await db.query('select state from public.workspaces')).rows;assert.deepEqual(rows,[{state:{test:'updated'}}]);
  await db.exec('reset role; set role anon');await assert.rejects(db.query('select * from public.workspaces'),/permission denied/);await assert.rejects(save(0,{}),/permission denied/);
 }finally{await db.close();}
});
