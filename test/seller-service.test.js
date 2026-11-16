import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createSellerRouter,beginSync,advanceSync,createReport,checkReport} from '../seller-service.js';

function memoryStore(){
 const resources=new Map(),meta=new Map(),leases=new Map();
 const clone=value=>value==null?null:structuredClone(value);
 const store={
  async list(kind){return [...(resources.get(kind)?.values()||[])].map(clone);},
  async get(kind,id){return clone(resources.get(kind)?.get(id));},
  async put(kind,id,value){if(!resources.has(kind))resources.set(kind,new Map());resources.get(kind).set(id,clone(value));return clone(value);},
  async putMany(kind,values){for(const value of values)await store.put(kind,value.id,value);return values;},
  async remove(kind,id){resources.get(kind)?.delete(id);},
  async getMeta(key){return clone(meta.get(key));},
  async setMeta(key,value){meta.set(key,clone(value));return clone(value);},
  async claim(key){if(leases.has(key))return null;const id=crypto.randomUUID();leases.set(key,id);return id;},
  async release(key,id){if(leases.get(key)===id)leases.delete(key);},
 };return store;
}
async function connectedStore(){const store=memoryStore();await store.setMeta('connection',{verified:true,seller:{id:'seller-1',currency:'USD'}});return store;}
async function serve(options,work){
 const app=express();app.use('/api/shop',createSellerRouter({env:{WHATNOT_SELLER_ID:'seller-1'},...options}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{return await work('http://127.0.0.1:'+server.address().port+'/api/shop');}
 finally{await new Promise(resolve=>server.close(resolve));}
}
const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('connection verifies seller and role, prevents accidental seller migration, hides token',async()=>{
 const store=memoryStore(),calls=[],client={request:async(...args)=>{calls.push(args);return{id:'seller-1',username:'storybook',currency:'USD'};}};
 await serve({store,client},async base=>{
  assert.equal((await fetch(base+'/sync',json('POST',{}))).status,409);
  const connected=await fetch(base+'/connect',json('POST',{}));assert.equal(connected.status,200);
  const payload=await(await fetch(base)).json();assert.equal(payload.connection.verified,true);assert.deepEqual(payload.products,[]);assert.equal(JSON.stringify(payload).includes('API_TOKEN'),false);
 });
 await serve({store,client,role:'editor'},async base=>assert.equal((await fetch(base+'/connect',json('POST',{}))).status,403));
 await serve({store,client:{request:async()=>({id:'seller-2'})},env:{WHATNOT_SELLER_ID:'seller-2'}},async base=>{
  assert.equal((await fetch(base+'/connect',json('POST',{}))).status,409);assert.equal((await store.getMeta('connection')).seller.id,'seller-1');
 });
});

test('full synchronization pages once per step, syncs children and analytics, prunes mirrored orphans but retains local notes',async()=>{
 const store=await connectedStore();await store.put('products','removed',{id:'removed'});await store.put('variants','orphan',{id:'orphan',product_id:'removed'});await store.put('stock','orphan',{id:'orphan',notes:'keep cost history'});
 const calls=[],client={
  page:async(path,cursor)=>{calls.push([path,cursor]);const data={
   '/products':cursor?{data:[{id:'p2'}],next_cursor:null}:{data:[{id:'p1'}],next_cursor:'second'},
   '/products/p1/variants':{data:[{id:'v1'}]},'/products/p2/variants':{data:[]},
   '/orders':{data:[{id:'o1'}]},'/orders/o1/items':{data:[{id:'oi1'}]},
   '/shipments':{data:[{id:'s1',status:'created'}]},'/shipments/s1/items':{data:[{id:'si1'}]},
   '/shows':{data:[{id:'show1',status:'ended'},{id:'live',status:'live'}]},
  }[path];assert.ok(data,path);return data;},
  request:async(method,path)=>{assert.equal(method,'GET');assert.equal(path,'/analytics/shows/show1');return{calculation_status:'PENDING',estimated_earnings:null};},
 };
 let job=await beginSync({store,client});assert.equal(job.status,'running');
 await advanceSync({store,client});assert.equal(calls.length,1);assert.equal((await store.getMeta('sync_job')).tasks[0].cursor,'second');assert.equal((await store.getMeta('connection')).lastSync,undefined);
 for(let i=0;i<50&&(await store.getMeta('sync_job')).status==='running';i++)await advanceSync({store,client});
 job=await store.getMeta('sync_job');assert.equal(job.status,'completed');assert.equal(job.counts.products,2);assert.equal(job.counts.variants,1);assert.ok((await store.getMeta('connection')).lastSync);
 assert.equal((await store.get('variants','v1')).product_id,'p1');assert.equal((await store.get('order_items','oi1')).order_id,'o1');assert.equal((await store.get('shipment_items','si1')).shipment_id,'s1');assert.equal((await store.get('analytics','show1')).calculation_status,'PENDING');
 assert.equal(await store.get('products','removed'),null);assert.equal(await store.get('variants','orphan'),null);assert.equal((await store.get('stock','orphan')).notes,'keep cost history');
});

test('failed sync resumes the same cursor, never reports a partial run as completed, and concurrent steps cannot overlap',async()=>{
 const store=await connectedStore();let fail=true,calls=0;
 const client={page:async()=>{calls++;if(fail)throw Object.assign(Error('secret upstream body'),{status:429});return{data:[],next_cursor:null};}};
 const first=await beginSync({store,client});await assert.rejects(advanceSync({store,client}));
 const failed=await store.getMeta('sync_job');assert.equal(failed.status,'error');assert.equal(failed.tasks[0].cursor,null);assert.equal(failed.error.includes('secret'),false);assert.equal((await store.getMeta('connection')).lastSync,undefined);
 fail=false;const resumed=await beginSync({store,client});assert.equal(resumed.id,first.id);await advanceSync({store,client});assert.equal(calls,2);
 const lease=await store.claim('sync');await assert.rejects(advanceSync({store,client}),error=>error.status===409);await store.release('sync',lease);
});

test('report requests use type-specific parameters, inclusive calendar end dates and validate dates/types',async()=>{
 const store=await connectedStore(),calls=[],client={request:async(method,path,body)=>{calls.push({method,path,body});return{id:'r'+calls.length,status:'pending',report_type:body.report_parameters.report_type};}};
 await createReport({store,client,startDate:'2026-11-01',endDate:'2026-11-16'});
 assert.deepEqual(calls[0].body,{report_parameters:{report_type:'seller_financial_report',start_date:'2026-11-01T00:00:00.000Z',end_date:'2026-11-17T00:00:00.000Z'}});
 await createReport({store,client,startDate:'2026-11-01',endDate:'2026-11-16',reportType:'analytics_overview_report'});
 assert.deepEqual(calls[1].body,{report_parameters:{report_type:'analytics_overview_report',start_at:'2026-11-01T00:00:00.000Z',end_at:'2026-11-17T00:00:00.000Z'}});
 for(const args of [{startDate:'2026-02-30',endDate:'2026-11-01'},{startDate:'2026-11-02',endDate:'2026-11-01'},{startDate:'2026-11-01',endDate:'2026-11-02',reportType:'arbitrary'}])await assert.rejects(createReport({store,client,...args}),error=>error.status===400);
 assert.equal(calls.length,2);
});

test('report completion imports once, strips download links, and does not advance imported marker after a failed financial commit',async()=>{
 const store=await connectedStore();await store.put('reports','report1',{id:'report1',reportType:'seller_financial_report',status:'pending'});
 let imports=0,fail=true;const downloads=[];
 const client={request:async()=>({id:'report1',status:'completed',report_type:'seller_financial_report',report_url:'https://provider.example/report.csv'}),downloadReport:async url=>{downloads.push(url);return Buffer.from('csv');}};
 const importFinancialReport=async(buffer,filename,type)=>{imports++;assert.equal(type,'seller_financial_report');assert.ok(Buffer.isBuffer(buffer));if(fail)throw Object.assign(Error('conflict'),{status:409});return{imported:1,skipped:0};};
 await assert.rejects(checkReport({store,client,id:'report1',importFinancialReport}),error=>error.status===409);
 assert.equal((await store.get('reports','report1')).importedAt,undefined);
 fail=false;const report=await checkReport({store,client,id:'report1',importFinancialReport});assert.ok(report.importedAt);assert.equal(report.report_url,undefined);assert.equal(report.importResult.imported,1);
 await checkReport({store,client,id:'report1',importFinancialReport});assert.equal(imports,2);assert.equal(downloads.length,2);
 await assert.rejects(checkReport({store,client,id:'another',importFinancialReport}),error=>error.status===404);
});

test('label requests stay queued, prevent duplicate generation and reopen existing labels for printing',async()=>{
 const store=await connectedStore();let ready=false,generations=0;
 const client={request:async(method,path,body)=>{
  if(method==='POST'){generations++;assert.equal(path,'/shipments/s1/generate_label');assert.equal(body,undefined);return{shipment_id:'s1'};}
  return{id:'s1',status:ready?'label_generated':'created',fulfillment_method:'shipping',required_actions:[],documents:ready?{label_url:'https://labels.example/current.pdf'}:null};
 }};
 await serve({store,client},async base=>{
  assert.equal((await fetch(base+'/shipments/s1/label',json('POST',{}))).status,400);
  const first=await fetch(base+'/shipments/s1/label',json('POST',{confirmed:true}));assert.equal(first.status,202);assert.equal((await first.json()).status,'queued');
  const second=await fetch(base+'/shipments/s1/label',json('POST',{confirmed:true}));assert.equal((await second.json()).status,'pending');assert.equal(generations,1);
  assert.equal((await(await fetch(base+'/shipments/s1/documents')).json()).status,'generating');
  ready=true;const documents=await(await fetch(base+'/shipments/s1/documents')).json();assert.equal(documents.status,'ready');assert.equal(documents.documents.label_url,'https://labels.example/current.pdf');
  const reprint=await fetch(base+'/shipments/s1/label',json('POST',{confirmed:true}));assert.equal((await reprint.json()).status,'ready');assert.equal(generations,1);
 });
});

test('uncertain label failures are not automatically retried; denied document access explains required permission',async()=>{
 const store=await connectedStore();let calls=0;
 const client={request:async method=>{if(method==='POST'){calls++;throw Object.assign(Error('private upstream credentials'),{status:504});}return{id:'s1',status:'created',required_actions:[],documents:null};}};
 await serve({store,client},async base=>{
  const first=await fetch(base+'/shipments/s1/label',json('POST',{confirmed:true}));assert.equal(first.status,504);assert.equal(JSON.stringify(await first.json()).includes('credentials'),false);
  const second=await fetch(base+'/shipments/s1/label',json('POST',{confirmed:true}));assert.equal((await second.json()).status,'pending');assert.equal(calls,1);
 });
 await serve({store,client:{request:async()=>({id:'s1',status:'label_generated',documents:null})}},async base=>{
  const denied=await fetch(base+'/shipments/s1/documents');assert.equal(denied.status,403);assert.match((await denied.json()).error,/read:customers/);
 });
});

test('viewers cannot mutate, but can open labels without trying to write to read-only persistence',async()=>{
 const store=await connectedStore();store.put=async()=>{throw Error('read-only database');};
 const client={request:async()=>({id:'s1',status:'label_generated',documents:{label_url:'https://labels.example/s1.pdf'}})};
 await serve({store,client,role:'viewer'},async base=>{
  for(const path of ['/connect','/sync','/reports','/shipments/s1/label','/inventory'])assert.equal((await fetch(base+path,json('POST',{confirmed:true}))).status,403);
  assert.equal((await fetch(base+'/stock/v1',json('PATCH',{unitCost:'1.23'}))).status,403);
  assert.equal((await fetch(base+'/shipments/s1/documents')).status,200);
 });
});

test('packing items join order purchase details and quantities without guessing missing or mismatched records',async()=>{
 const store=await connectedStore();
 await store.putMany('shipment_items',[
  {id:'si1',shipment_id:'s1',order_id:'o1',order_item_id:'oi1'},
  {id:'si2',shipment_id:'s1',order_id:'o2',order_item_id:'oi2'},
  {id:'si3',shipment_id:'s1',order_id:'o3',order_item_id:'missing'},
  {id:'other',shipment_id:'s2',order_id:'o1',order_item_id:'oi1'},
 ]);
 await store.putMany('order_items',[
  {id:'oi1',order_id:'o1',shipment_id:'s1',quantity:3,purchased_item:{title:'Mickey pin',sku:'MIC-1',description:'Blue enamel'}},
  {id:'oi2',order_id:'different-order',shipment_id:'s1',quantity:10,purchased_item:{title:'Wrong match',sku:'WRONG'}},
 ]);
 await serve({store,client:{}},async base=>{
  const {items}=await(await fetch(base+'/shipments/s1/items')).json();assert.equal(items.length,3);
  assert.equal(items[0].title,'Mickey pin');assert.equal(items[0].purchased_item.sku,'MIC-1');assert.equal(items[0].quantity,3);
  assert.equal(items[1].title,null);assert.equal(items[1].quantity,null);assert.equal(items[2].quantity,null);
 });
});

test('local stock notes are validated and remote inventory uses stable caller idempotency keys and handles per-item failure',async()=>{
 const store=await connectedStore();await store.put('variants','v1',{id:'v1',product_id:'p1',inventory:{available_quantity:3},price:{amount:'12.00',currency:'USD'}});
 const bodies=[];let rejected=true;
 const client={request:async(method,path,body)=>{
  if(method==='GET')return{id:'v1',product_id:'p1',inventory:{available_quantity:5},price:{amount:'12.00',currency:'USD'}};
  bodies.push(body);return{results:[{variant_id:'v1',idempotency_key:body.items[0].idempotency_key,status:rejected?'inventory_not_supported':'already_applied',new_quantity:8}]};
 }};
 await serve({store,client},async base=>{
  const saved=await fetch(base+'/stock/v1',json('PATCH',{unitCost:'1.25',location:'Drawer A',notes:'Lot 1'}));assert.equal(saved.status,200);assert.equal((await store.get('stock','v1')).unitCost,'1.25');
  assert.equal((await fetch(base+'/stock/v1',json('PATCH',{unitCost:'-1'}))).status,400);assert.equal((await fetch(base+'/stock/missing',json('PATCH',{}))).status,404);
  const body={variantId:'v1',quantity:8,idempotencyKey:'same-user-write-key'};
  assert.equal((await fetch(base+'/inventory',json('POST',body))).status,409);assert.equal((await store.get('variants','v1')).inventory.available_quantity,3);
  rejected=false;const success=await fetch(base+'/inventory',json('POST',body));assert.equal(success.status,200);assert.equal((await store.get('variants','v1')).inventory.available_quantity,5);
  assert.equal(bodies[0].items[0].idempotency_key,bodies[1].items[0].idempotency_key);
  assert.equal((await fetch(base+'/inventory',json('POST',{...body,quantity:-1}))).status,400);
 });
});

test('price updates use verified variant schema and known currency; unexpected results cannot overwrite the mirror',async()=>{
 const store=await connectedStore();await store.put('variants','v1',{id:'v1',product_id:'p1',price:{amount:'12.00',currency:'USD'}});const calls=[];let valid=true;
 const client={request:async(method,path,body)=>{calls.push({method,path,body});return valid?{variants:[{id:'v1',product_id:'p1',price:{amount:'14.50',currency:'USD'}}],errors:null}:{variants:[],errors:[{message:'private upstream data'}]};}};
 await serve({store,client},async base=>{
  assert.equal((await fetch(base+'/variants/v1/price',json('PATCH',{amount:'14.50'}))).status,200);
  assert.deepEqual(calls[0],{method:'PATCH',path:'/products/p1/variants',body:{variants:[{id:'v1',price:{amount:'14.50',currency:'USD'}}],allow_partial_updates:false}});
  valid=false;const failed=await fetch(base+'/variants/v1/price',json('PATCH',{amount:'20.00'}));assert.equal(failed.status,502);assert.equal((await store.get('variants','v1')).price.amount,'14.50');assert.equal(JSON.stringify(await failed.json()).includes('private upstream'),false);
  assert.equal((await fetch(base+'/variants/v1/price',json('PATCH',{amount:'0'}))).status,400);
 });
});
