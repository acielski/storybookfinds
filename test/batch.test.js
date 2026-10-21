import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.NODE_ENV='production';
const {createApp}=await import('../server.js');
let app,server,base;
async function start(path=':memory:'){app=await createApp(path);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;}
async function stop(){await new Promise(r=>server.close(r));app.locals.db.close();}
beforeEach(()=>start());afterEach(()=>stop());
const csv='date,description,category,amount\n2026-10-01,Packaging supplies,Supplies,12.50';
async function batch(files,type='expense'){const form=new FormData();form.set('type',type);for(const [name,text]of files)form.append('files',new Blob([text],{type:'text/csv'}),name);return fetch(base+'/api/import/batch',{method:'POST',body:form});}
const transactions=async()=> (await fetch(base+'/api/transactions')).json();
test('batch skips repeats within a file, across renamed overlapping files, and on retry',async()=>{
 const files=[['first.csv',csv+'\n2026-10-01,Packaging supplies,Supplies,12.50'],['renamed.csv',csv.replace('Packaging supplies','  PACKAGING   SUPPLIES ').replace('Supplies,12.50','supplies,12.5')],['more.csv',csv+'\n2026-10-02,Postage,Shipping,5.00']];
 const first=await (await batch(files)).json();assert.deepEqual(first.totals,{imported:2,skipped:3,updated:0,failed:0});assert.equal((await transactions()).length,2);
 const retry=await(await batch(files)).json();assert.deepEqual(retry.totals,{imported:0,skipped:5,updated:0,failed:0});assert.equal((await transactions()).length,2);
});
test('custom imports check legacy/manual data and preserve explicit row types',async()=>{
 app.locals.db.prepare('INSERT INTO transactions(type,date,description,category,cents) VALUES(?,?,?,?,?)').run('expense','2026-10-01','Packaging supplies','Supplies',1250);
 const result=await(await batch([['old.csv',csv],['mixed.csv','type,date,description,category,amount\nsale,2026-10-02,A pin,Online sales,15.00\nexpense,2026-10-02,Postage,Shipping,5.00']])).json();
 assert.equal(result.totals.skipped,1);assert.equal(result.totals.imported,2);assert.equal((await transactions()).filter(r=>r.type==='sale').length,1);
});
test('bad files roll back without stopping good files; retries are safe',async()=>{
 const result=await(await batch([['bad.csv',csv+'\n2026-10-02,Broken,Shipping,nope'],['valid.csv',csv],['not-csv.txt',csv]])).json();assert.equal(result.totals.failed,2);assert.equal(result.totals.imported,1);assert.match(result.results[0].error,/Row 3/);assert.equal((await transactions()).length,1);
});
const weekly='LEDGER_TRANSACTION_ID,TRANSACTION_COMPLETED_AT_UTC,TRANSACTION_CURRENCY,TRANSACTION_TYPE,TRANSACTION_AMOUNT,ORDER_ID\n101,2026-10-01 12:00:00,USD,ORDER_EARNINGS,10.00,1001';
test('Whatnot overlaps are skipped and conflicts roll back the entire conflicting file',async()=>{
 const changed=weekly.replace('101,','102,')+'\n101,2026-10-01 12:00:00,USD,ORDER_EARNINGS,99.00,1001';
 const result=await(await batch([['weekly.csv',weekly],['copy.csv',weekly],['conflict.csv',changed]])).json();assert.deepEqual(result.totals,{imported:1,skipped:1,updated:0,failed:1});assert.equal((await transactions()).length,1);
});
test('deduplication survives a database close and reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ledger-batch-test-'));
 try{await stop();await start(join(dir,'test.sqlite'));await batch([['first.csv',csv]]);await stop();await start(join(dir,'test.sqlite'));const result=await(await batch([['renamed.csv',csv]])).json();assert.equal(result.totals.skipped,1);assert.equal(result.totals.imported,0);assert.equal((await transactions()).length,1);}finally{await stop();rmSync(dir,{recursive:true,force:true});await start();}
});
test('upload limits and missing files return useful errors',async()=>{
 assert.equal((await batch([])).status,400);const many=await batch(Array.from({length:21},(_,i)=>[i+'.csv',csv]));assert.equal(many.status,400);assert.match((await many.json()).error,/at most 20/);
 const large=await batch([['large.csv','x'.repeat(2*1024*1024+1)]]);assert.equal(large.status,400);assert.match((await large.json()).error,/2 MB/);assert.equal((await transactions()).length,0);
});
