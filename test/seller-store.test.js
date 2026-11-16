import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createLocalSellerStore,createSupabaseSellerStore} from '../seller-store.js';

const owner='11111111-1111-1111-1111-111111111111';
const editor='22222222-2222-2222-2222-222222222222';
const viewer='33333333-3333-3333-3333-333333333333';
const outsider='44444444-4444-4444-4444-444444444444';
const config={url:'https://example.supabase.co',key:'sb_publishable_test'};
const cloudStore=fetchImpl=>createSupabaseSellerStore({config,token:'user-session',ownerId:owner,fetchImpl});

test('local seller entities and metadata survive a restart without duplicate IDs or partial invalid batches',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'seller-store-'));let db;
 try{
  const file=join(directory,'shop.sqlite');db=new DatabaseSync(file);const store=createLocalSellerStore(db);
  await store.putMany('orders',[{id:'order-2',status:'created'},{id:'order-1',status:'created'}]);
  await store.put('orders','order-1',{id:'order-1',status:'completed'});
  await store.setMeta('sync_job',{phase:'orders',cursor:'next-page'});
  await assert.rejects(store.putMany('orders',[{id:'would-be-partial'},{id:''}]),/resource ID/);
  assert.equal(await store.get('orders','would-be-partial'),null);
  db.close();db=new DatabaseSync(file);const restarted=createLocalSellerStore(db);
  assert.deepEqual(await restarted.list('orders'),[{id:'order-1',status:'completed'},{id:'order-2',status:'created'}]);
  assert.deepEqual(await restarted.getMeta('sync_job'),{phase:'orders',cursor:'next-page'});
  assert.equal(await restarted.get('shipments','order-1'),null);
  await restarted.remove('orders','order-1');assert.equal((await restarted.list('orders')).length,1);
  await restarted.setMeta('sync_job',null);assert.equal(await restarted.getMeta('sync_job'),null);
  await assert.rejects(restarted.put('orders','x',[]),/JSON objects/);
  await assert.rejects(restarted.get('../orders','x'),/resource type/);
 }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

test('local operation leases exclude another store instance, survive wrong release, and expire',async()=>{
 const db=new DatabaseSync(':memory:');try{
  const first=createLocalSellerStore(db),second=createLocalSellerStore(db);
  const token=await first.claim('label:shipment-1',90);assert.ok(token);
  assert.equal(await second.claim('label:shipment-1'),null);
  await second.release('label:shipment-1','wrong-token');assert.equal(await second.claim('label:shipment-1'),null);
  await first.release('label:shipment-1',token);const next=await second.claim('label:shipment-1');assert.ok(next);assert.notEqual(next,token);
  db.prepare('UPDATE seller_locks SET expires_at=0 WHERE key=?').run('label:shipment-1');
  assert.ok(await first.claim('label:shipment-1'));
  await assert.rejects(first.claim('invalid-ttl',301),/between 1 and 300/);
 }finally{db.close();}
});

test('Supabase seller storage pins every user operation to the workspace owner and preserves user JWT',async()=>{
 const calls=[];
 const store=cloudStore(async(url,options)=>{
  calls.push({url,options});
  if(options.method==='POST'||options.method==='DELETE')return new Response(null,{status:204});
  return new Response(JSON.stringify(url.includes('seller_metadata')?[{value:{step:2}}]:[{payload:{id:'order-1'}}]));
 });
 await store.list('orders');await store.get('orders','order-1');await store.put('orders','order-1',{id:'order-1'});
 await store.putMany('orders',[{id:'order-2'}]);await store.remove('orders','order-1');
 await store.getMeta('sync_job');await store.setMeta('sync_job',{step:2});await store.setMeta('sync_job',null);
 for(const {url,options}of calls){
  assert.equal(new URL(url).origin,config.url);
  assert.equal(options.headers.apikey,config.key);assert.equal(options.headers.Authorization,'Bearer user-session');
  if(options.method==='POST'){
   const rows=JSON.parse(options.body);for(const row of Array.isArray(rows)?rows:[rows])assert.equal(row.owner_id,owner);
  }else assert.equal(new URL(url).searchParams.get('owner_id'),'eq.'+owner);
 }
 assert.equal(calls.at(-1).options.method,'DELETE');
 assert.throws(()=>createSupabaseSellerStore({config,token:'token',ownerId:''}),/owner ID/);
 assert.throws(()=>createSupabaseSellerStore({config:{...config,url:'http://unsafe.test'},token:'token',ownerId:owner}),/not configured/);
});

test('Supabase lists every page and fails rather than silently returning a truncated collection',async()=>{
 let calls=0;
 const store=cloudStore(async url=>{calls++;const offset=Number(new URL(url).searchParams.get('offset'));return new Response(JSON.stringify(Array.from({length:offset===0?500:1},(_,i)=>({payload:{id:String(offset+i)}}))));});
 const items=await store.list('orders');assert.equal(items.length,501);assert.equal(calls,2);assert.equal(items.at(-1).id,'500');
 const oversized=cloudStore(async url=>{const offset=Number(new URL(url).searchParams.get('offset'));return new Response(JSON.stringify(Array.from({length:offset===10000?1:500},(_,i)=>({payload:{id:String(offset+i)}}))));});
 await assert.rejects(oversized.list('orders'),/exceeds 10,000/);
});

test('worker storage uses its server credential, scoped lease RPCs, and sanitized setup errors',async()=>{
 const calls=[];
 const worker=createSupabaseSellerStore({config,ownerId:owner,serviceKey:'server-only-secret',fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('seller_claim_lock'))return new Response(JSON.stringify(JSON.parse(options.body).p_token));
  if(url.endsWith('seller_release_lock'))return new Response('null');
  return new Response('[]');
 }});
 await worker.list('shipments');const lease=await worker.claim('sync-step',90);assert.ok(lease);await worker.release('sync-step',lease);
 for(const call of calls){assert.equal(call.options.headers.apikey,'server-only-secret');assert.equal(call.options.headers.Authorization,'Bearer server-only-secret');}
 const claim=JSON.parse(calls[1].options.body);assert.equal(claim.p_owner_id,owner);assert.equal(claim.p_ttl_seconds,90);assert.equal(claim.p_token,lease);
 const missing=cloudStore(async()=>new Response('sensitive upstream details',{status:404}));await assert.rejects(missing.getMeta('sync_job'),error=>error.status===503&&error.message.includes('003_seller_api.sql')&&!error.message.includes('sensitive'));
 const denied=cloudStore(async()=>new Response('token should never be exposed',{status:403}));await assert.rejects(denied.list('orders'),error=>error.status===403&&!error.message.includes('token'));
});

test('seller migration preserves ledger data, isolates shops, enforces viewer reads, and makes leases atomic',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for(const id of [owner,editor,viewer,outsider])await db.query('insert into auth.users values($1)',[id]);
  for(const file of ['001_workspace.sql','002_shared_workspaces.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await db.query('insert into public.workspaces(owner_id,state) values($1,$2::jsonb)',[owner,JSON.stringify({legacy:'untouched'})]);
  const migration=readFileSync(new URL('../supabase/migrations/003_seller_api.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
  await db.query("insert into public.workspace_members(member_id,owner_id,role) values($1,$2,'editor'),($3,$2,'viewer')",[editor,owner,viewer]);
  const asUser=async id=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
  const put=async(target,id)=>(await db.query("insert into public.seller_resources(owner_id,kind,resource_id,payload) values($1,'orders',$2,$3::jsonb) on conflict(owner_id,kind,resource_id) do update set payload=excluded.payload returning payload",[target,id,JSON.stringify({id,status:'created'})])).rows;
  const claim=async(target,token)=>(await db.query("select public.seller_claim_lock($1,'sync-step',$2,90) as lease",[target,token])).rows[0].lease;
  await asUser(owner);await put(owner,'order-1');await db.query("insert into public.seller_metadata(owner_id,key,value) values($1,'sync_job','{\"phase\":\"orders\"}')",[owner]);
  assert.equal(await claim(owner,'lease-one'),'lease-one');assert.equal(await claim(owner,'lease-two'),null);
  await db.query("select public.seller_release_lock($1,'sync-step','wrong-token')",[owner]);assert.equal(await claim(owner,'lease-three'),null);
  await db.query("select public.seller_release_lock($1,'sync-step','lease-one')",[owner]);assert.equal(await claim(owner,'lease-four'),'lease-four');
  await asUser(editor);assert.equal((await db.query('select * from public.seller_resources')).rows.length,1);await put(owner,'order-2');
  await assert.rejects(put(outsider,'foreign-order'),/row-level security/);
  await asUser(viewer);assert.equal((await db.query('select * from public.seller_resources')).rows.length,2);assert.equal((await db.query('select value from public.seller_metadata')).rows[0].value.phase,'orders');
  await assert.rejects(put(owner,'viewer-write'),/row-level security/);await assert.rejects(claim(owner,'viewer-lease'),/row-level security/);
  assert.equal((await db.query("delete from public.seller_resources returning resource_id")).rows.length,0);
  await asUser(outsider);assert.equal((await db.query('select * from public.seller_resources')).rows.length,0);assert.equal((await db.query('select * from public.seller_metadata')).rows.length,0);await assert.rejects(claim(owner,'outsider-lease'),/row-level security/);
  await db.exec('reset role');await db.query('delete from public.workspace_members where member_id=$1',[editor]);await asUser(editor);assert.equal((await db.query('select * from public.seller_resources')).rows.length,0);
  await db.exec("reset role;set role service_role;select set_config('request.jwt.claim.sub','',false)");
  await put(owner,'worker-order');assert.equal((await db.query('select state from public.workspaces where owner_id=$1',[owner])).rows[0].state.legacy,'untouched');
  await db.exec('reset role;set role anon');await assert.rejects(db.query('select * from public.seller_resources'),/permission denied/);await assert.rejects(claim(owner,'anon-lease'),/permission denied/);
 }finally{await db.close();}
});
