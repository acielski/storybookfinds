import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeApp,cloudConfig,supabaseGateway} from '../cloud.js';
const env={VERCEL:'1',SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'};
async function serve(app,work){const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{return await work('http://127.0.0.1:'+server.address().port);}finally{await new Promise(r=>server.close(r));}}
const row={type:'expense',date:'2026-10-21',description:'Pin supplies',category:'Packaging',amount:'12.50'};
const post=(token,body=row)=>({method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
function memoryGateway(){const users=new Map();return {users,async load(token){if(!['owner','other'].includes(token))throw Object.assign(Error('Invalid session'),{status:401});return structuredClone(users.get(token)||{version:0,state:null});},async save(token,version,state){if((users.get(token)?.version||0)!==version)throw Object.assign(Error('Concurrent update. Please retry.'),{status:409});users.set(token,{version:version+1,state:structuredClone(state)});return version+1;}};}
test('Vercel fails closed without configuration and rejects service-role credentials',async()=>{
 assert.throws(()=>cloudConfig({VERCEL:'1'}),/not configured/);assert.equal(cloudConfig({}),null);
 assert.throws(()=>cloudConfig({...env,SUPABASE_PUBLISHABLE_KEY:'sb_secret_do_not_use'}),/never a secret/);
 const jwt='e30.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.sig';assert.throws(()=>cloudConfig({...env,SUPABASE_PUBLISHABLE_KEY:jwt}),/service-role/);
 await serve(await createRuntimeApp({env:{VERCEL:'1'},apiOnly:true}),async base=>{assert.equal((await fetch(base+'/api/config')).status,503);assert.equal((await fetch(base+'/api/transactions')).status,503);});
});
test('cloud data requires a verified session and accounts are isolated',async()=>{
 const gateway=memoryGateway();await serve(await createRuntimeApp({env,gateway,apiOnly:true}),async base=>{
  const config=await(await fetch(base+'/api/config')).json();assert.equal(config.mode,'supabase');assert.equal(config.publishableKey,env.SUPABASE_PUBLISHABLE_KEY);
  assert.equal((await fetch(base+'/api/transactions')).status,401);assert.equal((await fetch(base+'/api/transactions',{headers:{Authorization:'Bearer invalid'}})).status,401);
  const saved=await fetch(base+'/api/transactions',post('owner'));assert.equal(saved.status,201);const id=(await saved.json()).id;
  assert.equal((await(await fetch(base+'/api/transactions',{headers:{Authorization:'Bearer other'}})).json()).length,0);
  assert.equal((await fetch(base+'/api/transactions/'+id,{method:'DELETE',headers:{Authorization:'Bearer other'}})).status,404);
  assert.equal((await(await fetch(base+'/api/transactions',{headers:{Authorization:'Bearer owner'}})).json()).length,1);
 });
});
test('cloud persists between fresh app instances, preserves IDs, and skips repeated imports',async()=>{
 const gateway=memoryGateway();let oldId;
 await serve(await createRuntimeApp({env,gateway,apiOnly:true}),async base=>{const r=await(await fetch(base+'/api/transactions',post('owner'))).json();oldId=r.id;await fetch(base+'/api/transactions/'+r.id,{method:'DELETE',headers:{Authorization:'Bearer owner'}});});
 await serve(await createRuntimeApp({env,gateway,apiOnly:true}),async base=>{
  const r=await(await fetch(base+'/api/transactions',post('owner'))).json();assert.ok(r.id>oldId);
  for(let i=0;i<2;i++){const data=new FormData();data.set('type','expense');data.set('file',new Blob(['date,description,category,amount\n2026-10-21,Another expense,Shipping,3.50']),'expenses.csv');const response=await fetch(base+'/api/import',{method:'POST',headers:{Authorization:'Bearer owner'},body:data});assert.equal(response.status,200);const result=await response.json();assert.equal(result.imported,i===0?1:0);assert.equal(result.skipped,i===1?1:0);}
  assert.equal((await(await fetch(base+'/api/transactions',{headers:{Authorization:'Bearer owner'}})).json()).length,2);
 });
});
test('concurrent cloud requests cannot silently overwrite each other',async()=>{
 const gateway=memoryGateway();let waiting=[];
 const load=gateway.load;gateway.load=async token=>{const snapshot=await load(token);await new Promise(resolve=>{waiting.push(resolve);if(waiting.length===2)waiting.forEach(r=>r());});return snapshot;};
 await serve(await createRuntimeApp({env,gateway,apiOnly:true}),async base=>{const responses=await Promise.all([fetch(base+'/api/transactions',post('owner')),fetch(base+'/api/transactions',post('owner',{...row,description:'A different expense'}))]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);assert.equal(gateway.users.get('owner').state.transactions.length,1);});
});
test('Supabase gateway validates session, uses user JWT and compare-and-swap RPC',async()=>{
 const calls=[];const gateway=supabaseGateway(cloudConfig(env),async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('/auth/')?{id:'user-123'}:url.includes('/rpc/')?null:[]),{status:200});});
 assert.deepEqual(await gateway.load('user-jwt'),{version:0,state:null});await assert.rejects(gateway.save('user-jwt',0,{}),e=>e.status===409);
 assert.equal(calls[0].options.headers.Authorization,'Bearer user-jwt');assert.equal(calls[2].options.headers.apikey,env.SUPABASE_PUBLISHABLE_KEY);assert.equal(JSON.parse(calls[2].options.body).expected_version,0);
});
