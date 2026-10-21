import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='production';
const {createApp,validate}=await import('../server.js');
let app,server,base;
before(async()=>{app=await createApp(':memory:');server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(r=>server.close(r));app.locals.db.close();});
const sample={type:'sale',date:'2026-10-21',description:'A book',category:'Online sales',amount:'19.99'};
test('manual sale persists in cents and can be deleted',async()=>{const res=await fetch(base+'/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sample)});assert.equal(res.status,201);const row=await res.json();assert.equal(row.cents,1999);const rows=await (await fetch(base+'/api/transactions')).json();assert.ok(rows.some(r=>r.id===row.id));assert.equal((await fetch(base+'/api/transactions/'+row.id,{method:'DELETE'})).status,204);});
test('validation rejects impossible dates, zero amounts and excess decimals',()=>{for(const override of [{date:'2026-02-30'},{amount:'0'},{amount:'1.999'},{description:''},{type:'other'}])assert.throws(()=>validate({...sample,...override}));});
async function upload(csv,type='expense'){const data=new FormData();data.set('type',type);data.set('file',new Blob([csv],{type:'text/csv'}),'expenses.csv');return fetch(base+'/api/import',{method:'POST',body:data});}
test('CSV imports quoted descriptions and expense records',async()=>{const res=await upload('date,description,category,amount\n2026-10-21,"Supplies, books",Supplies,12.34\n2026-10-20,Postage,Shipping,4.50');assert.equal(res.status,200);assert.equal((await res.json()).imported,2);const rows=await(await fetch(base+'/api/transactions')).json();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.type==='expense'));assert.equal(rows.find(r=>r.description==='Supplies, books').cents,1234);});
test('invalid CSV is atomic and returns a useful row error',async()=>{const res=await upload('date,description,category,amount\n2026-10-21,Valid,Supplies,10\n2026-10-21,Bad,Supplies,nope');assert.equal(res.status,400);assert.match((await res.json()).error,/Row 3/);assert.equal((await(await fetch(base+'/api/transactions')).json()).length,2);});
test('malformed JSON returns JSON error',async()=>{const res=await fetch(base+'/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{invalid'});assert.equal(res.status,400);assert.ok((await res.json()).error);});
