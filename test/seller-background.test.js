import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import express from 'express';
import {createSellerBackgroundRouter,verifyWhatnotWebhook,createWorkerFinancialImporter,runSellerCron} from '../seller-background.js';

const ownerId='11111111-1111-1111-1111-111111111111';
const instant=Date.parse('2026-11-16T12:00:00Z');
const signingKey=Buffer.alloc(32,7);
const env={WHATNOT_API_TOKEN:'wn_pat_tk_private_test',WHATNOT_SELLER_ID:'seller-1',WHATNOT_WORKSPACE_OWNER_ID:ownerId,
 SUPABASE_SERVICE_ROLE_KEY:'server-secret-test',CRON_SECRET:'c'.repeat(40),WHATNOT_WEBHOOK_SECRET:'wn_wh_'+signingKey.toString('base64')};
const config={url:'https://example.supabase.co',key:'publishable-test'};
const event={version:'v2',seller_id:'seller-1',type:'shipments.label_generated',timestamp:'2026-11-16T11:59:59.000Z',data:{shipment_id:'shipment-1',documents:{label_url:'https://provider.example/private.pdf'}}};
function delivery(value=event,{id='event-1',timestamp=String(instant/1000)}={}){
 const body=Buffer.from(JSON.stringify(value));
 const signature=createHmac('sha256',signingKey).update(id+'.'+timestamp+'.').update(body).digest('base64');
 return {body,headers:{'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+signature}};
}
function memoryStore(){
 const records=new Map(),meta=new Map(),leases=new Map();
 return {records,meta,async list(kind){return [...records.entries()].filter(([key])=>key.startsWith(kind+':')).map(([,value])=>structuredClone(value));},
  async get(kind,id){return structuredClone(records.get(kind+':'+id)||null);},async put(kind,id,value){records.set(kind+':'+id,structuredClone(value));return value;},
  async putMany(kind,values){for(const value of values)await this.put(kind,value.id,value);},async remove(kind,id){records.delete(kind+':'+id);},
  async getMeta(key){return structuredClone(meta.get(key)||null);},async setMeta(key,value){meta.set(key,structuredClone(value));return value;},
  async claim(key){if(leases.has(key))return null;const token='lease-'+key;leases.set(key,token);return token;},async release(key,token){if(leases.get(key)===token)leases.delete(key);}};
}
async function serve(options,work){
 const app=express();app.use('/api/whatnot-worker',createSellerBackgroundRouter({env,config,now:()=>instant,...options}));
 const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 try{return await work('http://127.0.0.1:'+server.address().port+'/api/whatnot-worker');}
 finally{await new Promise(resolve=>server.close(resolve));}
}
const post=message=>({method:'POST',headers:message.headers,body:message.body});

test('Whatnot signature verification uses exact bytes, supports rotated signatures, and rejects replay windows',()=>{
 const original=delivery();
 assert.equal(verifyWhatnotWebhook({...original,secret:env.WHATNOT_WEBHOOK_SECRET,now:instant}).event.seller_id,'seller-1');
 const headers=new Headers({...original.headers,'webhook-signature':'v1,bm90LXRoZS1zaWduYXR1cmU= '+original.headers['webhook-signature']});
 assert.equal(verifyWhatnotWebhook({...original,headers,secret:env.WHATNOT_WEBHOOK_SECRET,now:instant}).id,'event-1');
 assert.throws(()=>verifyWhatnotWebhook({...original,body:Buffer.from(original.body+' '),secret:env.WHATNOT_WEBHOOK_SECRET,now:instant}),/Invalid webhook signature/);
 assert.throws(()=>verifyWhatnotWebhook({...delivery(event,{timestamp:String(instant/1000-301)}),secret:env.WHATNOT_WEBHOOK_SECRET,now:instant}),/timestamp/);
 assert.throws(()=>verifyWhatnotWebhook({...original,secret:'not-a-whatnot-secret',now:instant}),/Configure/);
 assert.throws(()=>verifyWhatnotWebhook({...delivery({...event,version:'v1'}),secret:env.WHATNOT_WEBHOOK_SECRET,now:instant}),/Invalid webhook event/);
});

test('webhooks persist a minimal durable inbox before acknowledgement and deduplicate repeated delivery',async()=>{
 const store=memoryStore();
 await serve({storeFactory:()=>store},async base=>{
  for(let attempt=0;attempt<2;attempt++)assert.equal((await fetch(base+'/webhooks',post(delivery()))).status,204);
  const records=await store.list('events');assert.equal(records.length,1);assert.equal(records[0].status,'pending');
  assert.equal(records[0].receivedAt,'2026-11-16T12:00:00.000Z');
  assert.equal(JSON.stringify(records).includes('private.pdf'),false);
  assert.equal(records[0].data,undefined);
 });
});

test('invalid signatures, wrong sellers, malformed bodies and failed saves never acknowledge success',async()=>{
 const store=memoryStore();
 await serve({storeFactory:()=>store},async base=>{
  const invalid=delivery();invalid.headers['webhook-signature']='v1,'+Buffer.alloc(32).toString('base64');
  assert.equal((await fetch(base+'/webhooks',post(invalid))).status,400);
  assert.equal((await fetch(base+'/webhooks',post(delivery({...event,seller_id:'another-shop'})))).status,403);
  assert.equal((await fetch(base+'/webhooks',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,400);
  store.put=async()=>{throw Error('storage failed with sensitive details');};
  const failed=await fetch(base+'/webhooks',post(delivery()));assert.equal(failed.status,503);
  assert.equal((await failed.text()).includes('sensitive'),false);assert.equal((await store.list('events')).length,0);
 });
});

test('cron fails closed before using worker credentials, and verifies actual seller ownership',async()=>{
 const store=memoryStore();let calls=0;
 const factory=()=>({async request(){calls++;return {id:'different-seller'};}});
 await serve({storeFactory:()=>store,clientFactory:factory},async base=>{
  assert.equal((await fetch(base+'/cron')).status,401);
  assert.equal((await fetch(base+'/cron',{headers:{Authorization:'Bearer wrong'}})).status,401);assert.equal(calls,0);
  const response=await fetch(base+'/cron',{headers:{Authorization:'Bearer '+env.CRON_SECRET}});assert.equal(response.status,409);
  assert.equal(await store.getMeta('connection'),null);assert.equal(calls,1);
 });
 await serve({env:{...env,SUPABASE_SERVICE_ROLE_KEY:''},storeFactory:()=>{assert.fail('Must not construct store without setup');}},async base=>{
  assert.equal((await fetch(base+'/cron',{headers:{Authorization:'Bearer '+env.CRON_SECRET}})).status,503);
 });
});

const csv='ledger_transaction_id,transaction_completed_at_utc,transaction_currency,transaction_amount,transaction_type\nledger-1,2026-11-15T12:00:00.000Z,USD,12.34,TIP\n';
test('worker financial imports pin every load/save to configured owner and preserve atomic version checks',async()=>{
 const calls=[];
 const importer=createWorkerFinancialImporter({env,config,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(options.method==='PATCH')return new Response(JSON.stringify([{owner_id:ownerId,version:4}]));
  return new Response(JSON.stringify([{version:3,state:null}]));
 }});
 const result=await importer(Buffer.from(csv),'API.csv','seller_financial_report');assert.equal(result.imported,1);
 assert.equal(calls.length,2);
 for(const call of calls){assert.ok(call.url.startsWith(config.url+'/rest/v1/workspaces?'));assert.ok(call.url.includes('owner_id=eq.'+ownerId));assert.equal(call.options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);}
 assert.ok(calls[1].url.includes('version=eq.3'));
 const saved=JSON.parse(calls[1].options.body);assert.equal(saved.version,4);assert.equal(saved.state.records[0].source_key,'earnings:ledger-1');
 assert.equal(JSON.stringify(saved).includes(env.WHATNOT_API_TOKEN),false);
 const conflict=createWorkerFinancialImporter({env,config,fetchImpl:async(url,options)=>new Response(JSON.stringify(options.method==='PATCH'?[]:[{version:3,state:null}]))});
 await assert.rejects(conflict(Buffer.from(csv),'API.csv','seller_financial_report'),error=>error.status===409);
});

test('a worker first import cannot overwrite a concurrently created financial workspace',async()=>{
 const calls=[];
 const importer=createWorkerFinancialImporter({env,config,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('[]');}});
 await assert.rejects(importer(Buffer.from(csv),'API.csv','seller_financial_report'),error=>error.status===409);
 assert.equal(calls[1].options.method,'POST');assert.equal(calls[1].options.headers.Prefer,'resolution=ignore-duplicates,return=representation');
 assert.equal(JSON.parse(calls[1].options.body).owner_id,ownerId);
});

test('cron resumes bounded durable pages and leaves mid-sync webhook arrivals pending',async()=>{
 const store=memoryStore();
 await store.setMeta('connection',{verified:true,seller:{id:'seller-1'}});
 const startedAt='2026-11-16T11:00:00.000Z';
 await store.setMeta('sync_job',{id:'job-1',status:'running',startedAt,counts:{},tasks:[{kind:'shows',path:'/shows',mode:'page',cursor:null,seen:[],pageCount:0}]});
 await store.put('events','early',{id:'early',status:'pending',receivedAt:'2026-11-16T10:59:59.000Z'});
 await store.put('events','late',{id:'late',status:'pending',receivedAt:'2026-11-16T11:01:00.000Z'});
 await store.setMeta('worker_report_day:seller_financial_report','2026-11-16');
 await store.setMeta('worker_report_day:analytics_overview_report','2026-11-16');
 const result=await runSellerCron({env,config,store,client:{async page(){return {data:[],next_cursor:null};}},now:()=>instant});
 assert.equal(result.steps,1);assert.equal(result.syncStatus,'completed');assert.equal(result.eventsProcessed,1);
 assert.equal((await store.get('events','early')).status,'processed');assert.equal((await store.get('events','late')).status,'pending');
 const lease=await store.claim('worker_cron',60);
 assert.deepEqual(await runSellerCron({env,config,store,client:{},now:()=>instant}),{busy:true,steps:0});
 await store.release('worker_cron',lease);
});

test('a conflicting report does not starve catalog sync or advance the financial checkpoint',async()=>{
 const store=memoryStore();
 await store.setMeta('connection',{verified:true,seller:{id:'seller-1'}});
 await store.setMeta('worker_report_day:analytics_overview_report','2026-11-16');
 await store.put('reports','conflict',{id:'conflict',reportType:'seller_financial_report',status:'completed',startDate:'2026-11-09',endDate:'2026-11-15'});
 let pageCalls=0;
 const client={async request(method,path){
  if(path==='/reports/conflict')return {id:'conflict',report_type:'seller_financial_report',status:'completed',report_url:'https://files.example/report.csv'};
  assert.fail('Unexpected upstream request '+path);
 },async downloadReport(){return Buffer.from(csv);},async page(){pageCalls++;return {data:[],next_cursor:null};}};
 const result=await runSellerCron({env,config,store,client,now:()=>instant,
  importFinancialReport:async()=>{throw Object.assign(Error('Financial conflict'),{status:409});}});
 assert.equal(result.reportErrors,1);assert.equal(result.reportsImported,0);assert.ok(pageCalls>0);
 assert.equal((await store.get('reports','conflict')).importedAt,undefined);
 assert.match((await store.get('reports','conflict')).importError,/changed/);
 assert.equal(await store.getMeta('worker_report_day:seller_financial_report'),null);
});

test('an outage longer than seven days creates a bounded catch-up window from committed reports only',async()=>{
 const store=memoryStore();
 await store.setMeta('connection',{verified:true,seller:{id:'seller-1'}});
 await store.setMeta('worker_report_day:analytics_overview_report','2026-11-16');
 await store.put('reports','old',{id:'old',reportType:'seller_financial_report',status:'completed',endDate:'2026-09-01',importedAt:'2026-09-02T00:00:00Z'});
 // A requested but failed newer run must not skip the missing month.
 await store.put('reports','failed',{id:'failed',reportType:'seller_financial_report',status:'failed',endDate:'2026-11-15'});
 let parameters;
 const client={async request(method,path,body){
  assert.equal(method,'POST');assert.equal(path,'/reports');parameters=body.report_parameters;
  return {id:'catchup',report_type:'seller_financial_report',status:'pending'};
 },async page(){return {data:[],next_cursor:null};}};
 const result=await runSellerCron({env,config,store,client,now:()=>instant});
 assert.equal(result.reportsRequested,1);
 assert.equal(parameters.start_date,'2026-08-31T00:00:00.000Z');
 assert.equal(parameters.end_date,'2026-10-01T00:00:00.000Z');
 assert.equal((await store.get('reports','catchup')).endDate,'2026-09-30');
 assert.equal((await store.get('reports','catchup')).importedAt,undefined);
});

test('targeted label events fetch authoritative shipment data before marking the event processed',async()=>{
 const store=memoryStore();
 await store.setMeta('connection',{verified:true,seller:{id:'seller-1'}});
 for(const type of ['seller_financial_report','analytics_overview_report'])await store.setMeta('worker_report_day:'+type,'2026-11-16');
 await store.put('events','label',{id:'label',status:'pending',receivedAt:'2026-11-16T11:59:59Z',type:'shipments.label_generated',resource:{kind:'shipments',id:'ship-1'}});
 const client={async request(method,path){assert.equal(method,'GET');assert.equal(path,'/shipments/ship-1');return {id:'ship-1',status:'label_generated',documents:{label_url:'https://provider.example/current.pdf'}};},async page(){return {data:[],next_cursor:null};}};
 const result=await runSellerCron({env,config,store,client,now:()=>instant});
 assert.equal(result.eventsProcessed,1);assert.equal((await store.get('events','label')).status,'processed');
 // Full reconciliation may remove the mocked empty collection afterward;
 // the event is nevertheless processed through the current GET, never its body.
 assert.equal(result.eventErrors,0);
});

test('a small shop with more than four sync steps finishes its daily scan in one cron',async()=>{
 const store=memoryStore();
 await store.setMeta('connection',{verified:true,seller:{id:'seller-1'}});
 for(const type of ['seller_financial_report','analytics_overview_report'])await store.setMeta('worker_report_day:'+type,'2026-11-16');
 const pages={
  '/products':[{id:'product-1',title:'Castle pin'}],
  '/products/product-1/variants':[{id:'variant-1',sku:'CASTLE'}],
  '/orders':[{id:'order-1',status:'paid'}],
  '/orders/order-1/items':[{id:'order-item-1',quantity:1}],
  '/shipments':[{id:'shipment-1',status:'created'}],
  '/shipments/shipment-1/items':[{id:'shipment-item-1',quantity:1}],
  '/shows':[{id:'show-1',status:'ended'}],
 };
 const fetched=[];
 const client={async page(path,cursor){
  assert.equal(cursor,null);assert.ok(path in pages,'Unexpected collection '+path);fetched.push(path);
  return {data:pages[path],next_cursor:null};
 },async request(method,path){
  assert.equal(method,'GET');assert.equal(path,'/analytics/shows/show-1');fetched.push(path);
  return {show_id:'show-1',calculation_status:'completed'};
 }};
 const result=await runSellerCron({env,config,store,client,now:()=>instant});
 assert.ok(result.steps>4);assert.equal(result.syncStatus,'completed');
 assert.equal(fetched.length,8);
 for(const kind of ['products','variants','orders','order_items','shipments','shipment_items','shows','analytics'])
  assert.equal((await store.list(kind)).length,1,kind+' must be synchronized');
 assert.ok((await store.getMeta('connection')).lastSync);
 assert.deepEqual((await store.getMeta('sync_job')).tasks,[]);
});

test('the cron time budget stops a slow scan and later invocations resume its saved cursor',async()=>{
 const store=memoryStore();let clock=instant;
 await store.setMeta('connection',{verified:true,seller:{id:'seller-1'}});
 for(const type of ['seller_financial_report','analytics_overview_report'])await store.setMeta('worker_report_day:'+type,'2026-11-16');
 await store.setMeta('sync_job',{id:'slow-scan',status:'running',startedAt:new Date(instant).toISOString(),counts:{},
  tasks:[{kind:'shows',path:'/shows',mode:'page',cursor:null,seen:[],pageCount:0}]});
 const cursors=[];
 const client={async page(path,cursor){
  assert.equal(path,'/shows');cursors.push(cursor);clock+=10000;
  const index=cursor===null?0:Number(cursor.slice('cursor-'.length));
  assert.ok(index<7,'A completed cursor must never be fetched again');
  return {data:[{id:'show-'+index,status:'scheduled'}],next_cursor:index<6?'cursor-'+(index+1):null};
 }};
 const invoke=()=>runSellerCron({env,config,store,client,now:()=>clock});
 const first=await invoke();assert.equal(first.steps,3);assert.equal(first.syncStatus,'running');
 const checkpoint=await store.getMeta('sync_job');assert.equal(checkpoint.id,'slow-scan');
 assert.equal(checkpoint.tasks[0].cursor,'cursor-3');assert.equal(checkpoint.counts.shows,3);
 assert.equal((await store.list('shows')).length,3);
 const second=await invoke();assert.equal(second.steps,3);assert.equal(second.syncStatus,'running');
 assert.equal((await store.getMeta('sync_job')).tasks[0].cursor,'cursor-6');
 const third=await invoke();assert.equal(third.steps,1);assert.equal(third.syncStatus,'completed');
 assert.equal((await store.getMeta('sync_job')).id,'slow-scan');assert.equal((await store.list('shows')).length,7);
 assert.deepEqual(cursors,[null,'cursor-1','cursor-2','cursor-3','cursor-4','cursor-5','cursor-6']);
});
