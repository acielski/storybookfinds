import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createApp} from '../server.js';
import {createShopFactory,sellerBinding,verifiedSellerClient} from '../seller-runtime.js';
import {exportWorkspace} from '../workspace.js';

const env={WHATNOT_API_TOKEN:'wn_pat_tk_test_runtime',WHATNOT_SELLER_ID:'seller-1'};
async function serve(app,work){
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{return await work('http://127.0.0.1:'+server.address().port);}finally{await new Promise(resolve=>server.close(resolve));app.locals.db.close();}
}
const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('seller account binding fails closed for missing or different workspace IDs',()=>{
 assert.equal(sellerBinding({},{cloud:true}),false);
 assert.throws(()=>sellerBinding(env,{cloud:true,ownerId:'other'}),/owner/);
 const owner='11111111-1111-1111-1111-111111111111';
 assert.throws(()=>sellerBinding({...env,WHATNOT_WORKSPACE_OWNER_ID:owner},{cloud:true,ownerId:'22222222-2222-2222-2222-222222222222'}),e=>e.status===403);
 assert.equal(sellerBinding({...env,WHATNOT_WORKSPACE_OWNER_ID:owner},{cloud:true,ownerId:owner}),true);
});

test('rotated tokens must match the pinned seller before any resource read or write',async()=>{
 const calls=[];
 const client=verifiedSellerClient({async request(method,path){calls.push([method,path]);return {id:'another-seller'};},async page(){assert.fail('Wrong seller page');},async downloadReport(){assert.fail('Wrong seller download');}},'seller-1');
 await assert.rejects(client.request('POST','/shipments/1/generate_label'),e=>e.status===403);
 await assert.rejects(client.page('/orders'),e=>e.status===403);
 assert.deepEqual(calls,[['GET','/users/me']]);
});

test('thermal batch prints existing label PDFs with refreshed URLs, never generates new labels',async()=>{
 const source=await PDFDocument.create();source.addPage([288,432]);const bytes=Buffer.from(await source.save()),calls=[];
 const client={async request(method,path){calls.push([method,path]);if(path==='/users/me')return {id:'seller-1'};return {id:path.split('/').at(-1),fulfillment_method:'shipping',status:'label_generated',documents:{label_url:'https://labels.example/label.pdf'}};},async downloadReport(){return bytes;}};
 const app=await createApp(':memory:',{apiOnly:true,shopFactory:createShopFactory({env,ownerId:'local',clientFactory:()=>client})});
 await serve(app,async base=>{
  const response=await fetch(base+'/api/shop/labels/print',post({shipmentIds:['ship-1','ship-2']}));
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/pdf/);
  const printed=await PDFDocument.load(await response.arrayBuffer());assert.equal(printed.getPageCount(),2);assert.equal(printed.getPage(0).getWidth(),288);
  assert.ok(calls.every(([method])=>method==='GET'));assert.equal(calls.filter(([,path])=>path==='/users/me').length,1);
  assert.equal(exportWorkspace(app.locals.db).transactions.length,0);
 });
});

test('printing blocks viewers, invalid selections, and labels with a wrong paper size',async()=>{
 const source=await PDFDocument.create();source.addPage([612,792]);const bytes=Buffer.from(await source.save());
 const client={async request(method,path){return path==='/users/me'?{id:'seller-1'}:{id:'ship-1',fulfillment_method:'shipping',status:'label_generated',documents:{label_url:'https://labels.example/letter.pdf'}};},async downloadReport(){return bytes;}};
 for(const role of ['owner','viewer']){
  const app=await createApp(':memory:',{apiOnly:true,shopFactory:createShopFactory({env,ownerId:'local',role,clientFactory:()=>client})});
  await serve(app,async base=>{
   const response=await fetch(base+'/api/shop/labels/print',post({shipmentIds:['ship-1']}));
   assert.equal(response.status,role==='viewer'?403:409);
   if(role==='owner'){
    assert.match((await response.json()).error,/4 × 6/);
    assert.equal((await fetch(base+'/api/shop/labels/print',post({shipmentIds:['ship-1','ship-1']}))).status,400);
   }
  });
 }
});

test('integration configuration problems leave existing expenses usable',async()=>{
 const app=await createApp(':memory:',{apiOnly:true,shopFactory:createShopFactory({env:{WHATNOT_API_TOKEN:'configured-but-missing-seller'},ownerId:'local'})});
 await serve(app,async base=>{
  assert.equal((await fetch(base+'/api/shop')).status,503);
  assert.equal((await fetch(base+'/api/transactions',post({type:'expense',date:'2026-11-16',description:'Mailers',category:'Shipping',amount:'5.00'}))).status,201);
  const rows=await(await fetch(base+'/api/transactions')).json();assert.equal(rows.length,1);assert.equal(rows[0].cents,500);
 });
});
