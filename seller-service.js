import express from 'express';
import {randomUUID} from 'node:crypto';

const now=()=>new Date().toISOString();
const RESOURCE_KINDS=['products','variants','orders','shipments','shows','analytics','stock','reports'];
const REPORT_TYPES=new Set(['seller_financial_report','analytics_overview_report']);
const TOP_LEVEL=[['products','/products'],['orders','/orders'],['shipments','/shipments'],['shows','/shows']];
const MAX_RESOURCES=10000;

function issue(message,status=400){return Object.assign(new Error(message),{status,publicMessage:message});}
function identifier(value){
 if(typeof value!=='string'||!value.trim()||value.length>255||/[\u0000-\u001f]/.test(value))throw issue('Choose a valid shop record.');
 return value;
}
const pathId=value=>encodeURIComponent(identifier(value));
function safeError(error){
 if(error.publicMessage)return error.publicMessage;
 if(error.status===401)return 'Your Whatnot token expired or was revoked. Update it in Vercel and redeploy.';
 if(error.status===403)return 'Whatnot denied access. Check the token permissions and customer-data approval.';
 if(error.status===404)return 'This record is no longer available in Whatnot. Sync your shop again.';
 if(error.status===409)return 'The record changed or needs attention in Whatnot. Refresh and try again.';
 if(error.status===429)return 'Whatnot is busy. Wait a moment before trying again.';
 return 'Whatnot could not complete this action. Please try again.';
}

async function locked(store,key,work){
 if(!store.claim||!store.release)throw issue('The seller database needs the latest setup before syncing.',503);
 const lease=await store.claim(key,120);
 if(!lease)throw issue('This action is already running. Refresh in a moment.',409);
 try{return await work();}finally{await store.release(key,lease);}
}
async function connected(store,client){
 if(!client)throw issue('Add your Whatnot API token in Vercel to connect your shop.',503);
 const connection=await store.getMeta('connection');
 if(!connection?.verified||!connection.seller?.id)throw issue('Verify your Whatnot connection before syncing.',409);
 return connection;
}

function initialTasks(){return [
 ...TOP_LEVEL.map(([kind,path])=>({kind,path,mode:'page',cursor:null,seen:[],pageCount:0})),
 ...[['variants','products','product_id'],['order_items','orders','order_id'],['shipment_items','shipments','shipment_id'],['analytics','shows','show_id']].map(([kind,parentKind,parentField])=>({kind,parentKind,parentField,mode:'orphans'})),
 ];}
function externalRecord(record,parent={}){
 if(!record||typeof record!=='object'||!['string','number'].includes(typeof record.id))throw issue('Whatnot returned an unexpected record. No sync checkpoint was advanced.',502);
 return {...record,...parent,id:String(record.id),syncedAt:now()};
}
function jobView(job){
 if(!job)return null;
 const {tasks,...visible}=job;
 return {...visible,remainingTasks:tasks?.length||0};
}

export async function beginSync({store,client}){
 await connected(store,client);
 return locked(store,'sync',async()=>{
  const previous=await store.getMeta('sync_job');
  if(previous?.tasks?.length&&['running','error'].includes(previous.status)){
   const resumed={...previous,status:'running',error:null,updatedAt:now()};
   await store.setMeta('sync_job',resumed);return resumed;
  }
  const job={id:randomUUID(),status:'running',phase:'products',counts:{},startedAt:now(),updatedAt:now(),error:null,tasks:initialTasks()};
  await store.setMeta('sync_job',job);return job;
 });
}

async function appendChildren(store,task,tasks){
 if(!['products','orders','shipments','shows'].includes(task.kind)||task.parent)return;
 const parents=await store.list(task.kind);
 if(parents.length>MAX_RESOURCES)throw issue('This catalog is too large for one sync. Contact the shop owner.',413);
 const children=parents.flatMap(record=>{
  const id=pathId(String(record.id));
  if(task.kind==='products')return [{kind:'variants',path:`/products/${id}/variants`,parent:{product_id:String(record.id)},mode:'page',cursor:null,seen:[],pageCount:0}];
  if(task.kind==='orders')return [{kind:'order_items',path:`/orders/${id}/items`,parent:{order_id:String(record.id)},mode:'page',cursor:null,seen:[],pageCount:0}];
  if(task.kind==='shipments')return [{kind:'shipment_items',path:`/shipments/${id}/items`,parent:{shipment_id:String(record.id)},mode:'page',cursor:null,seen:[],pageCount:0}];
  return record.status==='ended'?[{kind:'analytics',path:`/analytics/shows/${id}`,id:String(record.id),parent:{show_id:String(record.id)},mode:'single'}]:[];
 });
 // Finish a resource and its children before moving to the next resource.
 tasks.unshift(...children);
}

async function finishTask(store,job,task){
 job.tasks.shift();
 await appendChildren(store,task,job.tasks);
 await store.setMeta(`synced_${task.kind}`,now());
}

export async function advanceSync({store,client}){
 await connected(store,client);
 return locked(store,'sync',async()=>{
  const stored=await store.getMeta('sync_job');
  if(!stored)return null;
  if(stored.status!=='running')return stored;
  // Mutation of the checkpoint is persisted only after this step's writes succeed.
  const job=structuredClone(stored),task=job.tasks[0];
  try{
   if(task?.mode==='orphans'){
    const parentIds=new Set((await store.list(task.parentKind)).map(record=>String(record.id)));
    task.stale=(await store.list(task.kind)).filter(record=>!parentIds.has(String(record[task.parentField]))).map(record=>String(record.id));
    if(task.stale.length)task.mode='prune';
    else await finishTask(store,job,task);
   }else if(task?.mode==='single'){
    const result=await client.request('GET',task.path);
    await store.put(task.kind,task.id,{...result,...task.parent,id:task.id,syncedAt:now()});
    job.counts[task.kind]=(job.counts[task.kind]||0)+1;
    await finishTask(store,job,task);
   }else if(task?.mode==='prune'){
    const batch=task.stale.slice(0,50);
    for(const id of batch)await store.remove(task.kind,id);
    task.stale=task.stale.slice(batch.length);
    if(!task.stale.length)await finishTask(store,job,task);
   }else if(task){
    const page=await client.page(task.path,task.cursor);
    if(!Array.isArray(page.data))throw issue('Whatnot returned an invalid page. Try syncing again.',502);
    const records=page.data.map(record=>externalRecord(record,task.parent));
    const seen=new Set([...task.seen,...records.map(record=>record.id)]);
    if(seen.size>MAX_RESOURCES||task.pageCount>=1000)throw issue('The sync reached its catalog limit. Ask the shop owner to review it.',413);
    if(page.next_cursor&&(page.next_cursor===task.cursor||task.cursorHistory?.includes(page.next_cursor)))throw issue('Whatnot repeated a page cursor. Retry the sync later.',502);
    await store.putMany(task.kind,records);
    task.seen=[...seen];task.pageCount++;task.cursorHistory=[...(task.cursorHistory||[]),task.cursor].filter(Boolean).slice(-100);task.cursor=page.next_cursor||null;
    job.counts[task.kind]=(job.counts[task.kind]||0)+records.length;
    if(!task.cursor){
     const old=await store.list(task.kind);
     task.stale=old.filter(record=>Object.entries(task.parent||{}).every(([key,value])=>record[key]===value)&&!seen.has(String(record.id))).map(record=>String(record.id));
     if(task.stale.length)task.mode='prune';
     else await finishTask(store,job,task);
    }
   }
   job.updatedAt=now();job.phase=job.tasks[0]?.kind||'complete';
   if(!job.tasks.length){
    job.status='completed';job.completedAt=now();
    const connection=await store.getMeta('connection');
    await store.setMeta('connection',{...connection,lastSync:job.completedAt});
   }
   await store.setMeta('sync_job',job);return job;
  }catch(error){
   // The old cursor remains available so resuming safely repeats at most one page.
   const failed={...stored,status:'error',updatedAt:now(),error:safeError(error)};
   await store.setMeta('sync_job',failed);
   throw error;
  }
 });
}

function dateWindow(startDate,endDate){
 const valid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
 if(!valid(startDate)||!valid(endDate)||startDate>endDate)throw issue('Choose a valid start and end date.');
 const end=new Date(endDate+'T00:00:00.000Z');end.setUTCDate(end.getUTCDate()+1);
 return {start_date:startDate+'T00:00:00.000Z',end_date:end.toISOString()};
}
function reportRecord(upstream,previous={}){
 if(!upstream?.id||!['pending','in_progress','completed','failed','cancelled'].includes(upstream.status))throw issue('Whatnot returned an unexpected report status.',502);
 const {report_url,...safe}=upstream;
 return {...previous,...safe,id:String(upstream.id),reportType:upstream.report_type||previous.reportType,checkedAt:now()};
}

export async function createReport({store,client,startDate,endDate,reportType='seller_financial_report'}){
 await connected(store,client);
 if(!REPORT_TYPES.has(reportType))throw issue('Choose a financial or daily overview report.');
 const range=dateWindow(startDate,endDate);
 const parameters=reportType==='analytics_overview_report'?{start_at:range.start_date,end_at:range.end_date}:range;
 return locked(store,'report-create',async()=>{
  const run=await client.request('POST','/reports',{report_parameters:{report_type:reportType,...parameters}});
  const previous=run?.id?await store.get('reports',String(run.id)):null;
  const report=reportRecord(run,{...previous,reportType,startDate,endDate,requestedAt:previous?.requestedAt||now()});
  await store.put('reports',report.id,report);return report;
 });
}

export async function checkReport({store,client,id,importFinancialReport}){
 await connected(store,client);identifier(id);
 return locked(store,'report:'+id,async()=>{
  const previous=await store.get('reports',id);
  if(!previous)throw issue('Choose a report requested by this shop.',404);
  if(previous.importedAt)return previous;
  const run=await client.request('GET','/reports/'+pathId(id));
  if(String(run.id)!==id)throw issue('Whatnot returned the wrong report. Please retry.',502);
  const report=reportRecord(run,previous);
  await store.put('reports',id,report);
  if(report.status!=='completed')return report;
  if(!REPORT_TYPES.has(report.reportType))throw issue('This report type is not supported for importing.');
  if(typeof run.report_url!=='string'||!run.report_url)throw issue('The report is complete but its download is not ready. Check again shortly.',409);
  if(typeof importFinancialReport!=='function')throw issue('Financial imports are unavailable in this runtime.',503);
  const buffer=await client.downloadReport(run.report_url);
  let result;
  try{result=await importFinancialReport(buffer,`Whatnot API ${report.reportType} ${id}.csv`,report.reportType);}
  catch(error){
   const failure={...report,importError:error.status===409?'Your records changed in another tab. Check this report again.':'This report needs reconciliation. No new financial rows from this attempt were committed.'};
   await store.put('reports',id,failure);
   throw issue(failure.importError,error.status===409?409:422);
  }
  const imported={...report,importedAt:now(),importResult:result,importError:null};
  await store.put('reports',id,imported);return imported;
 });
}

function documentsStatus(shipment,pending){
 if(shipment.documents?.label_url||shipment.documents?.bundled_url)return 'ready';
 if(shipment.status==='label_generated')throw issue('Whatnot has a label, but this token cannot access it. Check read:customers and customer-data approval.',403);
 return pending?'generating':'needs_label';
}
export async function refreshShipment({store,client,id,persist=true}){
 await connected(store,client);identifier(id);
 const shipment=externalRecord(await client.request('GET',`/shipments/${pathId(id)}`));
 if(shipment.id!==id)throw issue('Whatnot returned the wrong shipment. Please refresh.',502);
 if(persist)await store.put('shipments',id,shipment);
 return shipment;
}
function stockRecord(body,id){
 const raw=body?.unitCost;
 const unitCost=raw===null||raw===undefined||raw===''?null:String(raw);
 if(unitCost!==null&&(!/^\d+(\.\d{1,2})?$/.test(unitCost)||Number(unitCost)>1e9))throw issue('Enter a nonnegative unit cost with up to two decimal places.');
 const location=String(body?.location||'').trim(),notes=String(body?.notes||'').trim();
 if(location.length>120||notes.length>1000)throw issue('Use a location up to 120 characters and notes up to 1,000 characters.');
 return {id,unitCost:unitCost===null?null:Number(unitCost).toFixed(2),location,notes,updatedAt:now()};
}

export function createSellerRouter({store,client,env={},role='owner',ownerId,importFinancialReport}){
 const router=express.Router();router.use(express.json({limit:'32kb'}));
 router.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!['owner','editor','viewer'].includes(role))return next(issue('Sign in to access your shop.',401));
  if(!['GET','HEAD'].includes(req.method)&&role==='viewer')return next(issue('This account has view-only access.',403));
  next();
 });
 const route=handler=>(req,res,next)=>Promise.resolve(handler(req,res)).catch(next);
 router.get('/',route(async(req,res)=>{
  const [saved,job,...lists]=await Promise.all([store.getMeta('connection'),store.getMeta('sync_job'),...RESOURCE_KINDS.map(kind=>store.list(kind))]);
  const configured=Boolean(client&&env.WHATNOT_SELLER_ID);
  const verified=Boolean(configured&&saved?.verified&&String(saved.seller?.id)===String(env.WHATNOT_SELLER_ID));
  res.json({connection:{configured,verified,seller:saved?.seller||null,lastSync:saved?.lastSync||null},syncJob:jobView(job),...Object.fromEntries(RESOURCE_KINDS.map((kind,index)=>[kind,lists[index]]))});
 }));
 router.post('/connect',route(async(req,res)=>{
  if(role!=='owner')throw issue('Only the shop owner can verify its connection.',403);
  if(!client||!env.WHATNOT_SELLER_ID)throw issue('Add WHATNOT_API_TOKEN and WHATNOT_SELLER_ID in Vercel, then redeploy.',503);
  const seller=await client.request('GET','/users/me');
  if(!seller?.id||String(seller.id)!==String(env.WHATNOT_SELLER_ID))throw issue('This token belongs to a different seller. Check WHATNOT_SELLER_ID in Vercel.',403);
  const previous=await store.getMeta('connection');
  if(previous?.seller?.id&&String(previous.seller.id)!==String(seller.id))throw issue('This workspace is already connected to another seller. Migrate it before changing sellers.',409);
  const connection={verified:true,seller,verifiedAt:now(),lastSync:previous?.seller?.id===seller.id?previous.lastSync||null:null};
  await store.setMeta('connection',connection);res.json({connection:{...connection,configured:true}});
 }));
 router.use((req,res,next)=>Promise.resolve().then(async()=>{
  // A deliberate server-side seller change requires a new owner verification;
  // previous connection data must not authorize syncing a different account.
  const saved=await store.getMeta('connection');
  if(!saved?.verified||!env.WHATNOT_SELLER_ID||String(saved.seller?.id)!==String(env.WHATNOT_SELLER_ID))throw issue('Verify this shop connection before using Whatnot actions.',409);
 }).then(()=>next(),next));
 router.post('/sync',route(async(req,res)=>res.json({job:jobView(await beginSync({store,client}))})));
 router.post('/sync/step',route(async(req,res)=>res.json({job:jobView(await advanceSync({store,client}))})));
 router.post('/reports',route(async(req,res)=>res.status(202).json({report:await createReport({store,client,startDate:req.body?.startDate,endDate:req.body?.endDate,reportType:req.body?.reportType})})));
 router.post('/reports/:id/check',route(async(req,res)=>res.json({report:await checkReport({store,client,id:req.params.id,importFinancialReport})})));
 router.get('/shipments/:id/items',route(async(req,res)=>{
  const id=identifier(req.params.id);
  const [shipmentItems,orderItems]=await Promise.all([store.list('shipment_items'),store.list('order_items')]);
  const byId=new Map(orderItems.map(item=>[String(item.id),item]));
  const items=shipmentItems.filter(item=>item.shipment_id===id).map(item=>{
   const candidate=item.order_item_id?byId.get(String(item.order_item_id)):null;
   const matching=candidate&&(!item.order_id||String(candidate.order_id)===String(item.order_id))&&(!candidate.shipment_id||String(candidate.shipment_id)===id)?candidate:null;
   return {...item,purchased_item:matching?.purchased_item||null,title:matching?.purchased_item?.title||null,sku:matching?.purchased_item?.sku||null,quantity:Number.isSafeInteger(matching?.quantity)?matching.quantity:null};
  });
  res.json({items});
 }));
 router.get('/orders/:id/items',route(async(req,res)=>{
  identifier(req.params.id);res.json({items:(await store.list('order_items')).filter(item=>item.order_id===req.params.id)});
 }));
 router.get('/shipments/:id/documents',route(async(req,res)=>{
  const shipment=await refreshShipment({store,client,id:req.params.id,persist:role!=='viewer'});
  const pending=await store.getMeta('label:'+req.params.id);
  const status=documentsStatus(shipment,pending);
  res.json({status,documents:shipment.documents||null,shipment,requestedAt:pending?.requestedAt||null});
 }));
 router.post('/shipments/:id/label',route(async(req,res)=>{
  if(req.body?.confirmed!==true)throw issue('Confirm the show is finished and the shipment details are correct before generating a label.');
  const id=identifier(req.params.id);
  const result=await locked(store,'label:'+id,async()=>{
   const shipment=await refreshShipment({store,client,id});
   if(documentsStatus(shipment,null)==='ready')return {status:'ready',shipment};
   if(shipment.fulfillment_method==='pickup')throw issue('This order is pickup-only and does not need a shipping label.',409);
   if(shipment.status!=='created'||shipment.required_actions?.length)throw issue('Review this shipment in Whatnot before generating its label.',409);
   const pending=await store.getMeta('label:'+id);
   if(pending)return {status:'pending',shipment,requestedAt:pending.requestedAt};
   // Save an intention BEFORE the non-idempotent call: uncertain network failures
   // remain pending and are reconciled, never automatically sent a second time.
   const marker={shipmentId:id,requestedAt:now(),status:'requesting'};
   await store.setMeta('label:'+id,marker);
   try{
    await client.request('POST',`/shipments/${pathId(id)}/generate_label`);
   }catch(error){
    // A definite preflight rejection is safe for the seller to correct and retry.
    if([400,401,403,404,409,422,429].includes(error.status))await store.setMeta('label:'+id,null);
    else await store.setMeta('label:'+id,{...marker,status:'uncertain'});
    throw error;
   }
   await store.setMeta('label:'+id,{...marker,status:'queued'});
   return {status:'queued',shipment,requestedAt:marker.requestedAt};
  });
  res.status(result.status==='ready'?200:202).json(result);
 }));
 router.patch('/stock/:id',route(async(req,res)=>{
  const id=identifier(req.params.id);
  if(!await store.get('variants',id))throw issue('Sync this variant before adding its cost or location.',404);
  const stock=stockRecord(req.body,id);await store.put('stock',id,stock);res.json({stock});
 }));
 router.post('/inventory',route(async(req,res)=>{
  await connected(store,client);
  const id=identifier(req.body?.variantId),quantity=req.body?.quantity,key=req.body?.idempotencyKey;
  if(!Number.isSafeInteger(quantity)||quantity<0||quantity>2147483647)throw issue('Quantity must be a whole number between 0 and 2,147,483,647.');
  if(typeof key!=='string'||!key.trim()||key.length>255)throw issue('Provide a unique key for this inventory update.');
  const variant=await store.get('variants',id);
  if(!variant)throw issue('Sync this variant before changing its available quantity.',404);
  const result=await client.request('POST','/inventory/set',{items:[{variant_id:id,quantity,idempotency_key:key}]});
  const item=result?.results?.[0];
  if(result?.results?.length!==1||String(item.variant_id)!==id||item.idempotency_key!==key)throw issue('Whatnot returned an unexpected inventory result. Reuse the same update key when retrying.',502);
  if(!['applied','already_applied'].includes(item.status))throw issue('Whatnot could not update this variant inventory. Review the listing in Seller Hub.',409);
  // A replayed idempotency result may describe an older quantity. Read the live
  // variant instead of copying a potentially stale result into our catalog.
  let refreshed=null;
  try{
   refreshed=externalRecord(await client.request('GET',`/products/${pathId(variant.product_id)}/variants/${pathId(id)}`),{product_id:variant.product_id});
   if(refreshed.id!==id)refreshed=null;
   if(refreshed)await store.put('variants',id,refreshed);
  }catch{}
  res.json({result,variant:refreshed,refreshRequired:!refreshed});
 }));
 router.patch('/variants/:id/price',route(async(req,res)=>{
  const connection=await connected(store,client),id=identifier(req.params.id),amount=String(req.body?.amount??'');
  if(!/^\d+(\.\d{1,2})?$/.test(amount)||Number(amount)<=0||Number(amount)>1e9)throw issue('Enter a positive price with up to two decimal places.');
  const variant=await store.get('variants',id);
  if(!variant?.product_id)throw issue('Sync this variant before updating its price.',404);
  const currency=variant.price?.currency||connection.seller.currency;
  if(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))throw issue('Sync a valid currency for this listing before changing its price.',409);
  const result=await client.request('PATCH',`/products/${pathId(variant.product_id)}/variants`,{variants:[{id,price:{amount:Number(amount).toFixed(2),currency}}],allow_partial_updates:false});
  const updated=result?.variants?.find(record=>String(record.id)===id);
  if(!updated||result.errors?.length)throw issue('Whatnot did not confirm the price update. Sync the listing before retrying.',502);
  const saved=externalRecord(updated,{product_id:variant.product_id});await store.put('variants',id,saved);
  res.json({variant:saved});
 }));
 router.use((error,req,res,next)=>{
  const status=Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:502;
  if(error.retryAfter)res.set('Retry-After',String(error.retryAfter));
  res.status(status).json({error:safeError(error)});
 });
 return router;
}
