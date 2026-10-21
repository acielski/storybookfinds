import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pinMetrics} from '../src/pins.js';
import {exportWorkspace} from '../workspace.js';
process.env.NODE_ENV='production';
const {createApp,validate}=await import('../server.js');
let app,server,base;
beforeEach(async()=>{app=await createApp(':memory:',{apiOnly:true});server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});base='http://127.0.0.1:'+server.address().port;});
afterEach(async()=>{if(server.listening)await new Promise(r=>server.close(r));app.locals.db.close();});
const purchase={type:'expense',date:'2026-10-21',description:'Disney pin lot',category:'Pins',amount:'100.00',quantity:'25'};
const request=(body,method='POST')=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const rows=async()=> (await fetch(base+'/api/transactions')).json();
async function upload(csv){const form=new FormData();form.set('type','expense');form.set('file',new Blob([csv]),'pins.csv');return fetch(base+'/api/import',{method:'POST',body:form});}
const csv='date,description,category,amount,quantity\n2026-10-21,Disney pin lot,Pins,100.00,25';
test('weighted cost uses total purchase costs divided by total quantities, excluding non-pins and missing quantities',()=>{
 const metrics=pinMetrics([{type:'expense',category:'Pins',cents:10000,quantity:25},{type:'expense',category:'Pins',cents:15000,quantity:75},{type:'expense',category:'Pins & inventory',cents:5000,quantity:null},{type:'expense',category:'Shipping',cents:1000},{type:'sale',category:'Pins',cents:99999,quantity:10}]);
 assert.equal(metrics.quantity,100);assert.equal(metrics.costCents,25000);assert.equal(metrics.averageCents,250);assert.equal(metrics.missingQuantity,1);assert.equal(pinMetrics([]).averageCents,null);
});
test('pin quantity must be a positive whole number and cannot be attached to shipping',()=>{
 for(const quantity of ['',null,undefined,0,-1,1.5,'1e2','NaN',1000001])assert.throws(()=>validate({...purchase,quantity}),/quantity|number of pins/i);
 assert.throws(()=>validate({...purchase,category:'Shipping'}),/only used for Pins/);
 assert.equal(validate({...purchase,category:' pins ',quantity:'025'}).quantity,25);
});
test('manual pin purchases persist quantity and quantity edits recalculate the same purchase',async()=>{
 const saved=await(await fetch(base+'/api/transactions',request(purchase))).json();assert.equal(saved.quantity,25);assert.equal(pinMetrics(await rows()).averageCents,400);
 const response=await fetch(base+'/api/transactions/'+saved.id,request({quantity:50},'PATCH'));assert.equal(response.status,200);assert.equal(pinMetrics(await rows()).averageCents,200);assert.equal((await rows()).length,1);
 assert.equal((await fetch(base+'/api/transactions/'+saved.id,request({quantity:0},'PATCH'))).status,400);assert.equal(pinMetrics(await rows()).quantity,50);
});
test('pin CSV repeats skip duplicates; conflicting quantities fail without adding costs',async()=>{
 assert.equal((await(await upload(csv)).json()).imported,1);assert.equal((await(await upload(csv)).json()).skipped,1);
 const conflict=await upload(csv.replace(',25',',50'));assert.equal(conflict.status,400);assert.match((await conflict.json()).error,/different quantity/);assert.equal((await rows()).length,1);assert.equal(pinMetrics(await rows()).quantity,25);
});
test('legacy pin purchases can be enriched without duplicating costs; later failures roll back enrichment',async()=>{
 app.locals.db.prepare('INSERT INTO transactions(type,date,description,category,cents) VALUES(?,?,?,?,?)').run('expense','2026-10-21','Disney pin lot','Pins & inventory',10000);
 const fail=await upload(csv+'\n2026-10-21,Disney pin lot,Pins,100.00,50');assert.equal(fail.status,400);assert.equal((await rows())[0].quantity,null);
 const result=await(await upload(csv)).json();assert.equal(result.updated,1);assert.equal(result.imported,0);assert.equal((await rows()).length,1);assert.equal((await rows())[0].category,'Pins');assert.equal(pinMetrics(await rows()).quantity,25);
});
test('old SQLite databases and old Supabase snapshots load without losing data; quantities round trip',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'storybook-pins-'));let migrated,restored,legacy;
 try{
  const path=join(dir,'legacy.sqlite');const db=new DatabaseSync(path);db.exec("CREATE TABLE transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,date TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,cents INTEGER NOT NULL); INSERT INTO transactions(type,date,description,category,cents) VALUES('expense','2026-10-21','Old purchase','Pins & inventory',1234)");db.close();
  migrated=await createApp(path,{apiOnly:true});assert.equal(migrated.locals.db.prepare('SELECT quantity FROM transactions').get().quantity,null);
  migrated.locals.db.prepare('UPDATE transactions SET quantity=12').run();const snapshot=exportWorkspace(migrated.locals.db);
  restored=await createApp(':memory:',{apiOnly:true,state:snapshot});assert.equal(restored.locals.db.prepare('SELECT quantity FROM transactions').get().quantity,12);
  delete snapshot.transactions[0].quantity;legacy=await createApp(':memory:',{apiOnly:true,state:snapshot});assert.equal(legacy.locals.db.prepare('SELECT quantity FROM transactions').get().quantity,null);
 }finally{migrated?.locals.db.close();restored?.locals.db.close();legacy?.locals.db.close();rmSync(dir,{recursive:true,force:true});}
});
