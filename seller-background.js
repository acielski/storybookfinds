import express from 'express';
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createSellerClient} from './seller-client.js';
import {createSupabaseSellerStore} from './seller-store.js';
import {beginSync, advanceSync, createReport, checkReport} from './seller-service.js';
import {parseSellerReport, setupWhatnot} from './whatnot.js';
import {exportWorkspace, restoreWorkspace} from './workspace.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message,status=503)=>Object.assign(new Error(message),{status});
const equal=(a,b)=>{
 const left=Buffer.from(String(a)),right=Buffer.from(String(b));
 return left.length===right.length&&timingSafeEqual(left,right);
};

function workerSetup(env,config){
 if(!config?.url||!config?.key||!env.WHATNOT_API_TOKEN||!env.WHATNOT_SELLER_ID||
   !UUID.test(env.WHATNOT_WORKSPACE_OWNER_ID||'')||!env.SUPABASE_SERVICE_ROLE_KEY)
  throw fail('Automatic sync needs the server-only Whatnot, shop owner, and Supabase worker settings.');
 if(/[\s\x00-\x1f]/.test(env.WHATNOT_SELLER_ID))throw fail('Check the configured Whatnot seller ID.');
}

/** Verify exactly the bytes signed by Whatnot; parsed/reformatted JSON is unsafe. */
export function verifyWhatnotWebhook({body,headers,secret,now=Date.now()}){
 if(!Buffer.isBuffer(body))throw fail('A raw webhook body is required.',400);
 const encoded=String(secret||'').replace(/^wn_wh_/,'');
 if(!/^wn_wh_/.test(secret||'')||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw fail('Configure the Whatnot webhook signing secret.');
 const key=Buffer.from(encoded,'base64');
 if(key.length<16||key.toString('base64').replace(/=+$/,'')!==encoded.replace(/=+$/,''))throw fail('Configure the Whatnot webhook signing secret.');
 const header=name=>headers[name]??headers.get?.(name);
 const id=header('webhook-id'),timestamp=header('webhook-timestamp'),signatures=header('webhook-signature');
 if(typeof id!=='string'||!id||id.length>100||/[^A-Za-z0-9_.:-]/.test(id)||
   typeof timestamp!=='string'||!/^\d{1,12}$/.test(timestamp)||typeof signatures!=='string')throw fail('Invalid webhook signature.',400);
 if(Math.abs(now/1000-Number(timestamp))>300)throw fail('Webhook timestamp is outside the accepted window.',400);
 const expected=createHmac('sha256',key).update(id+'.'+timestamp+'.').update(body).digest();
 const valid=signatures.split(/\s+/).some(part=>{
  if(!part.startsWith('v1,'))return false;
  const value=part.slice(3);
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
  const received=Buffer.from(value,'base64');
  return received.length===expected.length&&timingSafeEqual(received,expected);
 });
 if(!valid)throw fail('Invalid webhook signature.',400);
 let event;try{event=JSON.parse(body.toString('utf8'));}catch{throw fail('Invalid webhook JSON.',400);}
 if(!event||typeof event!=='object'||Array.isArray(event)||event.version!=='v2'||
   typeof event.seller_id!=='string'||typeof event.type!=='string'||event.type.length>100||
   !/^[a-z]+(?:\.[a-z_]+)+$/.test(event.type)||!Number.isFinite(Date.parse(event.timestamp)))throw fail('Invalid webhook event.',400);
 return {id,event};
}

/** Owner-pinned compare-and-swap saves; worker credentials never impersonate a user. */
export function createWorkerFinancialImporter({env,config,fetchImpl=fetch}){
 workerSetup(env,config);
 const ownerId=env.WHATNOT_WORKSPACE_OWNER_ID;
 const origin=new URL(config.url);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw fail('Check the Supabase worker configuration.');
 const ownerFilter='owner_id=eq.'+encodeURIComponent(ownerId);
 async function request(path,options={}){
  let response;
  try{response=await fetchImpl(origin.origin+'/rest/v1/'+path,{...options,
   headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json',...options.headers},
   signal:AbortSignal.timeout(15000)});}catch{throw fail('Automatic sync could not reach financial storage.');}
  if(!response.ok)throw fail('Automatic sync could not save financial records.',response.status===409?409:503);
  let value;try{value=await response.json();}catch{throw fail('Financial storage returned an unexpected response.');}
  return value;
 }
 return async(buffer,filename,reportType)=>{
  // Validate before loading any existing financial state.
  const parsed=parseSellerReport(buffer,reportType);
  const loaded=await request('workspaces?'+ownerFilter+'&select=version,state&limit=1');
  if(!Array.isArray(loaded)||loaded.length>1)throw fail('Financial storage returned an unexpected workspace.');
  const version=loaded[0]?.version||0;
  if(!Number.isSafeInteger(version)||version<0)throw fail('Financial storage returned an invalid workspace version.');
  const db=new DatabaseSync(':memory:');
  try{
   db.exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,date TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,cents INTEGER NOT NULL,quantity INTEGER)');
   const whatnot=setupWhatnot(db);
   restoreWorkspace(db,loaded[0]?.state||null);
   const result=whatnot.importReport(parsed,filename,()=>{throw fail('Only Whatnot financial reports can be synchronized.',400);});
   const state=exportWorkspace(db);
   let saved;
   if(version===0){
    saved=await request('workspaces?on_conflict=owner_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({owner_id:ownerId,version:1,state})});
   }else{
    saved=await request('workspaces?'+ownerFilter+'&version=eq.'+version,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({state,version:version+1,updated_at:new Date().toISOString()})});
   }
   if(!Array.isArray(saved)||saved.length!==1||saved[0].owner_id!==ownerId||saved[0].version!==version+1)
    throw fail('Your financial records changed during sync. They will be reloaded before the next attempt.',409);
   return result;
  }finally{db.close();}
 };
}

async function boundClient({env,clientFactory,fetchImpl,store}){
 const client=clientFactory({token:env.WHATNOT_API_TOKEN,fetchImpl});
 const seller=await client.request('GET','/users/me');
 if(!seller||String(seller.id)!==env.WHATNOT_SELLER_ID)throw fail('The Whatnot token belongs to a different seller. Check the server settings.',409);
 const previous=await store.getMeta('connection');
 if(previous?.seller?.id&&String(previous.seller.id)!==env.WHATNOT_SELLER_ID)
  throw fail('This workspace is connected to another Whatnot seller.',409);
 await store.setMeta('connection',{...previous,verified:true,seller,verifiedAt:new Date().toISOString(),
  tokenFingerprint:createHash('sha256').update(env.WHATNOT_API_TOKEN).digest('hex')});
 return client;
}

const isDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
 Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
function catchupWindow(reports,reportType,instant){
 const today=new Date(instant).toISOString().slice(0,10);
 let startDate=new Date(instant-6*86400000).toISOString().slice(0,10);
 const importedEnds=reports.filter(report=>(report.reportType||report.report_type)===reportType&&report.importedAt&&isDate(report.endDate))
  .map(report=>report.endDate).sort();
 if(importedEnds.length){
  const overlap=new Date(Date.parse(importedEnds.at(-1)+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  if(overlap<startDate)startDate=overlap;
 }
 const segmentEnd=new Date(Date.parse(startDate+'T00:00:00Z')+30*86400000).toISOString().slice(0,10);
 return {startDate,endDate:segmentEnd<today?segmentEnd:today};
}
function eventResource(event){
 const data=event.data;
 if(!data||typeof data!=='object')return null;
 const prefix=event.type.split('.')[0];
 if(!['products','orders','shipments','shows'].includes(prefix))return null;
 const singular=prefix.slice(0,-1);
 const id=data[singular+'_id']??data.id??data[singular]?.id;
 return ['string','number'].includes(typeof id)&&String(id).length<=255?{kind:prefix,id:String(id)}:null;
}
async function reconcileEvent(store,client,event,instant){
 const resource=event.resource;
 if(!resource||!['products','orders','shipments','shows'].includes(resource.kind)||typeof resource.id!=='string')return false;
 try{
  const current=await client.request('GET','/'+resource.kind+'/'+encodeURIComponent(resource.id));
  if(!current||String(current.id)!==resource.id)throw fail('Whatnot returned an unexpected webhook resource.',502);
  await store.put(resource.kind,resource.id,{...current,id:resource.id,syncedAt:new Date(instant).toISOString()});
 }catch(error){
  if(event.type==='products.deleted'&&error.status===404)await store.remove(resource.kind,resource.id);
  else throw error;
 }
 await store.put('events',event.id,{...event,status:'processed',processedAt:new Date(instant).toISOString()});
 return true;
}

/** Every invocation has a durable checkpoint; no work is left running after response. */
export async function runSellerCron({env,config,fetchImpl=fetch,store,client,now=Date.now,importFinancialReport}){
 const started=now(),deadline=started+28000;
 const lease=await store.claim('worker_cron',60);
 if(!lease)return {busy:true,steps:0};
 const result={steps:0,reportsRequested:0,reportsImported:0,eventsProcessed:0,reportErrors:0,eventErrors:0};
 try{
  const reports=await store.list('reports');
  const importer=importFinancialReport||createWorkerFinancialImporter({env,config,fetchImpl});
  // Poll at most two reports. A report is marked imported only after its
  // financial workspace has committed successfully through the callback.
  for(const report of reports.filter(r=>!r.importedAt&&!['failed','cancelled'].includes(r.status)).slice(0,2)){
   if(now()>=deadline)break;
   try{
    const checked=await checkReport({store,client,id:report.id,importFinancialReport:importer});
    if(checked.importedAt)result.reportsImported++;
    Object.assign(report,checked);
   }catch{
    result.reportErrors++;
    // A reconciliation conflict must not starve order/shipment updates.
    // checkReport retains the unimported report and safe importError details.
   }
  }
  const today=new Date(started).toISOString().slice(0,10);
  for(const reportType of ['seller_financial_report','analytics_overview_report']){
   if(now()>=deadline)break;
   const key='worker_report_day:'+reportType;
   const {startDate,endDate}=catchupWindow(reports,reportType,started);
   if(await store.getMeta(key)===today&&endDate===today)continue;
   if(reports.some(r=>(r.reportType||r.report_type)===reportType&&!r.importedAt&&!['failed','cancelled'].includes(r.status)))continue;
   try{
    await createReport({store,client,startDate,endDate,reportType});
    await store.setMeta(key,today);result.reportsRequested++;
   }catch{result.reportErrors++;}
  }
  // Known resources can be refreshed directly. This avoids waiting for an
  // entire large catalog scan before a label/order update becomes visible.
  const inbox=await store.list('events');
  for(const event of inbox.filter(value=>value.status==='pending'&&value.resource).slice(0,2)){
   if(now()>=deadline)break;
   try{if(await reconcileEvent(store,client,event,now()))result.eventsProcessed++;}
   catch{result.eventErrors++;}
  }
  let job=await store.getMeta('sync_job');
  if(now()<deadline){job=await beginSync({store,client});}
  // A page may itself take up to the upstream timeout. Stop starting new
  // work early enough to leave time for the current request and checkpoint.
  // A small shop should finish its daily scan in one invocation; the time
  // budget, rather than an artificial four-page cap, bounds larger catalogs.
  for(let index=0;index<100&&job?.status==='running'&&now()<deadline;index++){
   job=await advanceSync({store,client});result.steps++;
  }
  if(job?.status==='completed'){
   const completedBefore=Date.parse(job.startedAt||job.started_at||'');
   for(const event of await store.list('events')){
    // Mid-sync arrivals may concern a collection already fetched. Leave
    // those in the inbox for the next complete reconciliation.
    if(event.status==='pending'&&Date.parse(event.receivedAt)<=completedBefore){
     await store.put('events',event.id,{...event,status:'processed',processedAt:new Date(now()).toISOString()});
     result.eventsProcessed++;
    }else if(event.status==='processed'&&now()-Date.parse(event.receivedAt)>7*86400000){
     await store.remove('events',event.id);
    }
   }
  }
  result.syncStatus=job?.status||'idle';
  await store.setMeta('worker_last_run',{...result,at:new Date(now()).toISOString()});
  return result;
 }finally{await store.release('worker_cron',lease);}
}

export function createSellerBackgroundRouter({env=process.env,config,fetchImpl=fetch,
 storeFactory=createSupabaseSellerStore,clientFactory=createSellerClient,now=Date.now}={}){
 const router=express.Router();
 const store=()=>storeFactory({config,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,ownerId:env.WHATNOT_WORKSPACE_OWNER_ID,fetchImpl});
 router.get('/cron',async(req,res)=>{
  try{
   if(typeof env.CRON_SECRET!=='string'||env.CRON_SECRET.length<32)throw fail('Configure a CRON_SECRET of at least 32 characters.');
   if(!equal(req.get('authorization')||'','Bearer '+env.CRON_SECRET))throw fail('Unauthorized automatic sync request.',401);
   workerSetup(env,config);
   const persistence=store();
   const client=await boundClient({env,clientFactory,fetchImpl,store:persistence});
   res.set('Cache-Control','no-store').json(await runSellerCron({env,config,fetchImpl,store:persistence,client,now}));
  }catch(error){res.status(error.status||503).json({error:error.status?error.message:'Automatic sync could not finish. Retry to resume from its checkpoint.'});}
 });
 router.post('/webhooks',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
  try{
   workerSetup(env,config);
   const {id,event}=verifyWhatnotWebhook({body:req.body,headers:req.headers,secret:env.WHATNOT_WEBHOOK_SECRET,now:now()});
   if(event.seller_id!==env.WHATNOT_SELLER_ID)throw fail('Webhook seller does not match this shop.',403);
   const persistence=store(),key='webhook:'+id;
   const lease=await persistence.claim(key,30);
   if(!lease)throw fail('This webhook is already being saved. Retry delivery.',503);
   try{
    if(!await persistence.get('events',id)){
     // Store a durable notification, not a stale customer-data snapshot.
     // A full API reconciliation reads authoritative current resource state.
     await persistence.put('events',id,{id,type:event.type,seller_id:event.seller_id,timestamp:event.timestamp,resource:eventResource(event),
      receivedAt:new Date(now()).toISOString(),status:'pending'});
    }
   }finally{await persistence.release(key,lease);}
   res.status(204).end();
  }catch(error){res.status(error.status||503).json({error:error.status?error.message:'The webhook could not be saved. Retry delivery.'});}
 });
 router.use((error,req,res,next)=>res.status(error.status||400).json({error:'Invalid webhook request.'}));
 return router;
}
