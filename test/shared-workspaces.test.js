import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createRuntimeApp,cloudConfig,supabaseGateway} from '../cloud.js';
const owner='11111111-1111-1111-1111-111111111111',editor='22222222-2222-2222-2222-222222222222',viewer='33333333-3333-3333-3333-333333333333',outsider='44444444-4444-4444-4444-444444444444';
test('shared shop SQL preserves data, grants member access, blocks outsiders and viewer writes, and revokes immediately',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text unique);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for(const [i,id] of [owner,editor,viewer,outsider].entries())await db.query('insert into auth.users(id,email) values($1,$2)',[id,`user${i}@example.test`]);
  await db.exec(readFileSync(new URL('../supabase/migrations/001_workspace.sql',import.meta.url),'utf8'));
  await db.query('insert into public.workspaces(owner_id,state) values($1,$2::jsonb)',[owner,JSON.stringify({existing:'kept'})]);
  const migration=readFileSync(new URL('../supabase/migrations/002_shared_workspaces.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
  await db.query("insert into public.workspace_members(member_id,owner_id,role) values($1,$2,'editor')",[editor,owner]);
  const addMember=readFileSync(new URL('../supabase/admin/add_shop_member.sql',import.meta.url),'utf8').replaceAll('OWNER_APP_EMAIL','user0@example.test').replaceAll('NEW_USER_EMAIL','user2@example.test');
  await db.exec(addMember);await assert.rejects(db.exec(addMember),/already has a membership/);
  const asUser=async id=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
  const save=async(version,state)=>(await db.query('select public.save_workspace($1,$2::jsonb) as version',[version,JSON.stringify(state)])).rows[0].version;
  await asUser(editor);assert.deepEqual((await db.query('select public.workspace_context() as context')).rows[0].context,{ownerId:owner,role:'editor'});assert.deepEqual((await db.query('select state from public.workspaces')).rows,[{state:{existing:'kept'}}]);assert.equal(await save(1,{shared:'updated'}),2);assert.equal(await save(1,{shared:'stale'}),null);
  await assert.rejects(db.query("update public.workspace_members set role='editor' where member_id=$1",[viewer]),/permission denied/);
  await asUser(viewer);assert.deepEqual((await db.query('select state from public.workspaces')).rows,[{state:{shared:'updated'}}]);await assert.rejects(save(2,{attack:'overwrite'}),/read-only/);assert.equal((await db.query("update public.workspaces set state='{}' returning owner_id")).rows.length,0);
  await asUser(outsider);assert.equal((await db.query('select * from public.workspaces')).rows.length,0);assert.equal((await db.query('select * from public.workspace_members')).rows.length,0);await assert.rejects(db.query('insert into public.workspace_members(member_id,owner_id) values($1,$2)',[outsider,owner]),/permission denied/);
  await db.exec('reset role');await db.query('delete from public.workspace_members where member_id=$1',[editor]);await asUser(editor);assert.equal((await db.query('select * from public.workspaces')).rows.length,0);
  await asUser(owner);assert.deepEqual((await db.query('select state from public.workspaces')).rows,[{state:{shared:'updated'}}]);
 }finally{await db.close();}
});
test('development configuration blocks production database reuse and unconfigured previews',()=>{
 const env={VERCEL:'1',SUPABASE_URL:'https://live.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'};
 assert.throws(()=>cloudConfig({...env,APP_ENV:'development'}),/PRODUCTION_SUPABASE_URL/);
 assert.throws(()=>cloudConfig({...env,APP_ENV:'development',PRODUCTION_SUPABASE_URL:env.SUPABASE_URL}),/pointing at the production/);
 assert.throws(()=>cloudConfig({...env,VERCEL_ENV:'preview'}),/separate development database/);
 assert.equal(cloudConfig({...env,SUPABASE_URL:'https://test.supabase.co',APP_ENV:'development',PRODUCTION_SUPABASE_URL:env.SUPABASE_URL}).url,'https://test.supabase.co');
});
test('gateway queries the shared owner instead of the member private workspace',async()=>{
 const urls=[];const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'};
 const gateway=supabaseGateway(cloudConfig(env),async url=>{urls.push(url);return new Response(JSON.stringify(url.includes('/auth/')?{id:editor}:url.includes('workspace_context')?{ownerId:owner,role:'viewer'}:[{version:5,state:{shared:true}}]));});
 assert.deepEqual(await gateway.load('token'),{version:5,state:{shared:true},role:'viewer'});assert.ok(urls.at(-1).includes('owner_id=eq.'+owner));
});
test('viewer API can read the shared data but cannot save, delete or import',async()=>{
 const app=await createRuntimeApp({env:{VERCEL:'1',SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'},apiOnly:true,gateway:{async load(){return {role:'viewer',version:0,state:null};},async save(){assert.fail('Viewer must never persist');}}});
 const server=app.listen(0,'127.0.0.1');await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});const base='http://127.0.0.1:'+server.address().port,headers={Authorization:'Bearer viewer-token'};
 try{
  assert.equal((await fetch(base+'/api/transactions',{headers})).status,200);assert.deepEqual(await(await fetch(base+'/api/session',{headers})).json(),{role:'viewer'});
  for(const [method,path]of [['POST','/api/transactions'],['DELETE','/api/transactions/1'],['PATCH','/api/transactions/1'],['POST','/api/import']])assert.equal((await fetch(base+path,{method,headers})).status,403);
 }finally{await new Promise(r=>server.close(r));}
});
