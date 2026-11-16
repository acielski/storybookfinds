import {randomUUID} from 'node:crypto';

const MAX_RECORDS=10000;
const PAGE_SIZE=500;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message,status=503)=>Object.assign(new Error(message),{status,publicMessage:message});
function kindName(value){
 if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(value))throw fail('Invalid seller resource type.',400);
 return value;
}
function resourceId(value){
 if(typeof value!=='string'||!value.trim()||value.length>512||/[\x00-\x1f\x7f]/.test(value))throw fail('Invalid seller resource ID.',400);
 return value;
}
function metaKey(value){
 if(typeof value!=='string'||!/^[a-zA-Z0-9_.:-][a-zA-Z0-9_.:-]{0,127}$/.test(value))throw fail('Invalid seller metadata key.',400);
 return value;
}
function jsonValue(value,{object=false}={}){
 if(object&&(value===null||typeof value!=='object'||Array.isArray(value)))throw fail('Seller records must be JSON objects.',400);
 let serialized;
 try{serialized=JSON.stringify(value);}catch{throw fail('Seller data must be valid JSON.',400);}
 if(serialized===undefined||Buffer.byteLength(serialized)>1024*1024)throw fail('Seller data must be valid JSON under 1 MB.',400);
 return serialized;
}
function ttlValue(value){
 if(!Number.isInteger(value)||value<1||value>300)throw fail('A seller operation lease must last between 1 and 300 seconds.',400);
 return value;
}
function batchRows(kind,records){
 kindName(kind);
 if(!Array.isArray(records)||records.length>MAX_RECORDS)throw fail('Sync at most 10,000 seller records at a time.',400);
 return records.map(payload=>({id:resourceId(payload?.id),payload:jsonValue(payload,{object:true})}));
}

// Separate from the financial workspace snapshot: these tables survive local
// restarts and never put tokens or synchronized customer data in ledger exports.
export function createLocalSellerStore(db){
 db.exec(`CREATE TABLE IF NOT EXISTS seller_resources (
   kind TEXT NOT NULL,resource_id TEXT NOT NULL,payload TEXT NOT NULL,
   updated_at TEXT NOT NULL,PRIMARY KEY(kind,resource_id));
  CREATE TABLE IF NOT EXISTS seller_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS seller_locks (key TEXT PRIMARY KEY,lease_token TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
 const write=db.prepare('INSERT INTO seller_resources(kind,resource_id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,resource_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at');
 return {
  async list(kind){
   const rows=db.prepare('SELECT payload FROM seller_resources WHERE kind=? ORDER BY resource_id LIMIT ?').all(kindName(kind),MAX_RECORDS+1);
   if(rows.length>MAX_RECORDS)throw fail('This seller collection exceeds 10,000 records. Narrow the sync range before continuing.');
   return rows.map(row=>JSON.parse(row.payload));
  },
  async get(kind,id){const row=db.prepare('SELECT payload FROM seller_resources WHERE kind=? AND resource_id=?').get(kindName(kind),resourceId(id));return row?JSON.parse(row.payload):null;},
  async put(kind,id,payload){write.run(kindName(kind),resourceId(id),jsonValue(payload,{object:true}),new Date().toISOString());return payload;},
  async putMany(kind,records){
   const rows=batchRows(kind,records),now=new Date().toISOString();
   db.exec('BEGIN');
   try{for(const row of rows)write.run(kind,row.id,row.payload,now);db.exec('COMMIT');}
   catch(error){db.exec('ROLLBACK');throw error;}
   return records;
  },
  async remove(kind,id){db.prepare('DELETE FROM seller_resources WHERE kind=? AND resource_id=?').run(kindName(kind),resourceId(id));},
  async getMeta(key){const row=db.prepare('SELECT value FROM seller_metadata WHERE key=?').get(metaKey(key));return row?JSON.parse(row.value):null;},
  async setMeta(key,value){db.prepare('INSERT INTO seller_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(metaKey(key),jsonValue(value));return value;},
  async claim(key,ttlSeconds=90){
   key=metaKey(key);ttlValue(ttlSeconds);const token=randomUUID(),now=Date.now();
   const row=db.prepare('INSERT INTO seller_locks(key,lease_token,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET lease_token=excluded.lease_token,expires_at=excluded.expires_at WHERE seller_locks.expires_at<=? RETURNING lease_token').get(key,token,now+ttlSeconds*1000,now);
   return row?.lease_token||null;
  },
  async release(key,token){db.prepare('DELETE FROM seller_locks WHERE key=? AND lease_token=?').run(metaKey(key),resourceId(token));},
 };
}

// A normal request keeps the user's JWT and row-level permissions. A worker
// passes a server-only service key and still pins every query to one owner.
export function createSupabaseSellerStore({config,token,ownerId,fetchImpl=fetch,serviceKey}={}){
 if(typeof ownerId!=='string'||!UUID.test(ownerId))throw fail('Configure the shop owner ID before connecting Whatnot.');
 let origin;
 try{origin=new URL(config?.url);}catch{throw fail('Supabase seller storage is not configured.');}
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!config?.key)throw fail('Supabase seller storage is not configured.');
 const credential=serviceKey||token,apiKey=serviceKey||config.key;
 if(typeof credential!=='string'||!credential.trim())throw fail('Sign in before accessing seller data.',401);
 const ownerFilter='owner_id=eq.'+encodeURIComponent(ownerId);
 async function request(path,options={}){
  let response;
  try{response=await fetchImpl(origin.origin+'/rest/v1/'+path,{...options,headers:{apikey:apiKey,Authorization:'Bearer '+credential,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});}
  catch{throw fail('Cannot reach seller storage. Please try again.');}
  if(!response.ok){
   if(response.status===401)throw fail('Your session expired. Please sign in again.',401);
   if(response.status===403)throw fail('Your account cannot change this shop’s seller data.',403);
   if(response.status===404)throw fail('Seller storage needs setup. Run Supabase migration 003_seller_api.sql, then try again.');
   if(response.status===409)throw fail('Seller data changed in another request. Refresh and try again.',409);
   throw fail('Seller storage could not complete this request. Please try again.');
  }
  if(response.status===204)return null;
  const body=await response.text();
  if(!body)return null;
  try{return JSON.parse(body);}catch{throw fail('Seller storage returned an unexpected response. Please try again.');}
 }
 function query(table,filters){return table+'?'+ownerFilter+'&'+filters;}
 return {
  async list(kind){
   const items=[];
   for(let offset=0;offset<=MAX_RECORDS;offset+=PAGE_SIZE){
    const rows=await request(query('seller_resources','kind=eq.'+encodeURIComponent(kindName(kind))+'&select=payload&order=resource_id.asc&limit='+PAGE_SIZE+'&offset='+offset));
    if(!Array.isArray(rows)||rows.length>PAGE_SIZE||rows.some(row=>!row?.payload||typeof row.payload!=='object'||Array.isArray(row.payload)))throw fail('Seller storage returned an unexpected collection.');
    items.push(...rows.map(row=>row.payload));
    if(items.length>MAX_RECORDS)throw fail('This seller collection exceeds 10,000 records. Narrow the sync range before continuing.');
    if(rows.length<PAGE_SIZE)return items;
   }
   throw fail('This seller collection exceeds 10,000 records. Narrow the sync range before continuing.');
  },
  async get(kind,id){
   const rows=await request(query('seller_resources','kind=eq.'+encodeURIComponent(kindName(kind))+'&resource_id=eq.'+encodeURIComponent(resourceId(id))+'&select=payload&limit=1'));
   if(!Array.isArray(rows))throw fail('Seller storage returned an unexpected response.');
   return rows[0]?.payload??null;
  },
  async put(kind,id,payload){
   kind=kindName(kind);id=resourceId(id);jsonValue(payload,{object:true});
   await request('seller_resources?on_conflict=owner_id,kind,resource_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({owner_id:ownerId,kind,resource_id:id,payload,updated_at:new Date().toISOString()})});
   return payload;
  },
  async putMany(kind,records){
   const rows=batchRows(kind,records),now=new Date().toISOString();
   // Each page is an atomic upsert. Repeating a partially completed sync is safe.
   for(let offset=0;offset<rows.length;offset+=100){
    await request('seller_resources?on_conflict=owner_id,kind,resource_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows.slice(offset,offset+100).map(row=>({owner_id:ownerId,kind,resource_id:row.id,payload:JSON.parse(row.payload),updated_at:now})))});
   }
   return records;
  },
  async remove(kind,id){await request(query('seller_resources','kind=eq.'+encodeURIComponent(kindName(kind))+'&resource_id=eq.'+encodeURIComponent(resourceId(id))),{method:'DELETE'});},
  async getMeta(key){
   const rows=await request(query('seller_metadata','key=eq.'+encodeURIComponent(metaKey(key))+'&select=value&limit=1'));
   if(!Array.isArray(rows))throw fail('Seller storage returned an unexpected response.');
   return rows[0]?.value??null;
  },
  async setMeta(key,value){
   key=metaKey(key);jsonValue(value);
   if(value===null){await request(query('seller_metadata','key=eq.'+encodeURIComponent(key)),{method:'DELETE'});return null;}
   await request('seller_metadata?on_conflict=owner_id,key',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({owner_id:ownerId,key,value,updated_at:new Date().toISOString()})});
   return value;
  },
  async claim(key,ttlSeconds=90){
   const leaseToken=randomUUID();
   const result=await request('rpc/seller_claim_lock',{method:'POST',body:JSON.stringify({p_owner_id:ownerId,p_key:metaKey(key),p_token:leaseToken,p_ttl_seconds:ttlValue(ttlSeconds)})});
   if(result!==null&&result!==leaseToken)throw fail('Seller storage returned an unexpected operation lease.');
   return result;
  },
  async release(key,leaseToken){await request('rpc/seller_release_lock',{method:'POST',body:JSON.stringify({p_owner_id:ownerId,p_key:metaKey(key),p_token:resourceId(leaseToken)})});},
 };
}
