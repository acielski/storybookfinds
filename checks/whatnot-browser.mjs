// Actual React -> Express -> Whatnot client -> SQLite -> React flow.
// Every upstream call is a fixture; this script never contacts a live seller.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {PDFDocument} from 'pdf-lib';
import {createRuntimeApp} from '../cloud.js';

process.env.NODE_ENV='production';
const pdf=await PDFDocument.create();pdf.addPage([288,432]);const label=Buffer.from(await pdf.save());
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
let variant={id:'variant-1',product_id:'product-1',sku:'PIN-001',price:{amount:'12.00',currency:'USD'},inventory:{available_quantity:3}};
const reports=new Map(),calls=[];
let labelRequests=0;
const shipment={id:'shipment-1',status:'label_generated',fulfillment_method:'shipping',recipient:{username:'testbuyer'},documents:{label_url:'https://1.1.1.1/fixture-label.pdf'},url:'https://www.whatnot.com/dashboard/shipments/shipment-1'};
const fixtureFetch=async(value,options={})=>{
 const url=new URL(value),method=options.method||'GET';calls.push({method,path:url.pathname});
 if(url.hostname==='1.1.1.1'){
  assert.equal(options.headers?.Authorization,undefined,'Seller token must not reach document hosts');
  if(url.pathname==='/fixture-label.pdf')return new Response(label,{headers:{'Content-Type':'application/pdf'}});
  return new Response('ledger_transaction_id,transaction_completed_at_utc,transaction_currency,transaction_type,transaction_amount,listing_title,quantity_sold,cost_of_goods\nledger-1,2026-11-15T10:00:00Z,USD,ORDER_EARNINGS,8.50,Fixture pin,1,2.00\n');
 }
 assert.equal(url.origin,'https://api.whatnot.com');
 const path=url.pathname.replace('/seller-api/rest/v2','');
 if(path==='/users/me')return json({id:'seller-1',username:'fixture_shop',currency:'USD'});
 if(path==='/products')return json({data:[{id:'product-1',title:'Fixture castle pin',url:'https://www.whatnot.com/product/product-1'}],next_cursor:null});
 if(path==='/products/product-1/variants'&&method==='GET')return json({data:[variant],next_cursor:null});
 if(path==='/products/product-1/variants/variant-1')return json(variant);
 if(path==='/inventory/set'){
  const item=JSON.parse(options.body).items[0];variant={...variant,inventory:{available_quantity:item.quantity}};
  return json({results:[{...item,status:'applied',new_quantity:item.quantity,previous_quantity:3,warnings:[]}]});
 }
 if(path==='/products/product-1/variants'&&method==='PATCH'){
  variant={...variant,price:JSON.parse(options.body).variants[0].price};return json({variants:[variant],errors:[]});
 }
 if(path==='/orders')return json({data:[{id:'order-1',status:'completed',buyer:{username:'testbuyer'},created_at:'2026-11-15T09:00:00Z',amounts:{total:{amount:'12.00',currency:'USD'}}}],next_cursor:null});
 if(path==='/orders/order-1/items')return json({data:[{id:'order-item-1',order_id:'order-1',quantity:1,purchased_item:{title:'Fixture castle pin',sku:'PIN-001'}}],next_cursor:null});
 if(path==='/shipments')return json({data:[shipment],next_cursor:null});
 if(path==='/shipments/shipment-1')return json(shipment);
 if(path==='/shipments/shipment-1/items')return json({data:[{id:'shipment-item-1',shipment_id:'shipment-1',order_id:'order-1',order_item_id:'order-item-1'}],next_cursor:null});
 if(path.endsWith('/generate_label')){labelRequests++;throw Error('Reprints must never generate labels');}
 if(path==='/shows')return json({data:[{id:'show-1',title:'Fixture pin show',status:'ended',start_time:'2026-11-14T19:00:00Z'}],next_cursor:null});
 if(path==='/analytics/shows/show-1')return json({calculation_status:'CALCULATED',estimated_sales:{amount:'12.00',currency:'USD'},orders_count:1,distinct_viewers_count:10});
 if(path==='/reports'&&method==='POST'){
  const params=JSON.parse(options.body).report_parameters,id='report-'+(reports.size+1);
  const report={id,status:'pending',report_type:params.report_type,report_parameters:params};reports.set(id,report);return json(report);
 }
 if(path.startsWith('/reports/'))return json({...reports.get(path.split('/').at(-1)),status:'completed',report_url:'https://1.1.1.1/fixture-report.csv'});
 throw Error('Unexpected simulated Whatnot request: '+method+' '+path);
};

const app=await createRuntimeApp({env:{NODE_ENV:'production',DB_PATH:':memory:',WHATNOT_API_TOKEN:'wn_pat_tk_fixture_only',WHATNOT_SELLER_ID:'seller-1'},fetchImpl:fixtureFetch});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
// Chromium's PDF navigation can discard the DevTools response body. Observe a
// clone of the bytes received by the actual UI fetch before its popup opens.
await page.addInitScript(()=>{
 const original=window.fetch;
 window.fetch=async(...args)=>{
  const response=await original(...args);
  if(String(args[0]).endsWith('/api/shop/labels/print')&&response.ok)
   window.__printedLabelBytes=Array.from(new Uint8Array(await response.clone().arrayBuffer()));
  return response;
 };
});
page.on('pageerror',error=>errors.push(error.message));
page.setDefaultTimeout(15000);
const nav=name=>page.locator('nav').getByRole('button',{name,exact:true}).click();
const artifacts=process.env.SHOP_CHECK_ARTIFACTS||'/tmp/storybook-check';await mkdir(artifacts,{recursive:true});
try{
 await page.goto(base);
 await page.getByRole('heading',{name:'Your shop, one lovely day at a time'}).waitFor();
 await nav('Settings');
 await page.getByRole('button',{name:'Verify connection',exact:true}).first().click();
 await page.getByText('Your Whatnot shop is verified.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Sync shop',exact:true}).click();
 await page.getByText('Shop sync finished.',{exact:false}).waitFor({timeout:60000});
 await nav('Inventory');await page.getByText('Fixture castle pin',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Manage',exact:true}).click();
 await page.getByLabel('Purchase cost per pin (USD)').fill('2.00');
 await page.getByLabel('Storage location').fill('Tray A3');
 await page.getByRole('button',{name:'Save notes',exact:true}).click();
 await page.getByText('Tray A3',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Manage',exact:true}).click();
 await page.getByLabel('Available quantity',{exact:true}).fill('7');
 await page.getByRole('button',{name:'Set Whatnot quantity',exact:true}).click();
 await page.getByText('Available quantity updated in Whatnot.',{exact:true}).waitFor();
 await page.getByLabel('Listing price (USD)').fill('14.00');
 await page.getByRole('button',{name:'Set Whatnot price',exact:true}).click();
 await page.getByText('Listing price updated in Whatnot.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Close inventory notes'}).click();
 assert.equal(variant.inventory.available_quantity,7);assert.equal(variant.price.amount,'14.00');
 await nav('Orders');await page.getByText('testbuyer',{exact:true}).waitFor();
 await nav('Shipping');await page.getByRole('button',{name:'Items',exact:true}).click();
 await page.locator('.shop-items-list').getByText('Fixture castle pin',{exact:false}).waitFor();await page.getByText('Qty 1',{exact:true}).waitFor();
 await page.getByLabel('Select shipment shipment-1',{exact:true}).check();
 const printed=page.waitForResponse(response=>response.url().endsWith('/api/shop/labels/print'));
 const popup=page.waitForEvent('popup');
 await page.getByRole('button',{name:'Print selected',exact:true}).click();
 const response=await printed;assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/application\/pdf/);
 await page.waitForFunction(()=>window.__printedLabelBytes?.length>0);
 const printBytes=Buffer.from(await page.evaluate(()=>window.__printedLabelBytes));
 assert.equal(printBytes.subarray(0,5).toString(),'%PDF-',JSON.stringify({length:printBytes.length,prefix:printBytes.subarray(0,100).toString(),headers:response.headers()}));
 const printedPdf=await PDFDocument.load(printBytes);assert.equal(printedPdf.getPageCount(),1);assert.equal(printedPdf.getPage(0).getWidth(),288);assert.equal(labelRequests,0);
 await(await popup).close();
 await page.screenshot({path:artifacts+'/shipping.png',fullPage:true});
 await nav('Money');
 await page.getByRole('button',{name:'Request report',exact:true}).click();
 await page.getByRole('button',{name:'Check & import',exact:true}).click();
 await page.getByText('Report imported and reconciled',{exact:false}).waitFor();
 const transactions=await(await fetch(base+'/api/transactions')).json();
 assert.equal(transactions.filter(row=>row.type==='sale').reduce((sum,row)=>sum+row.cents,0),850);
 await page.getByRole('button',{name:'Check',exact:true}).click();
 assert.equal((await(await fetch(base+'/api/transactions')).json()).length,2,'Rechecking must not duplicate sale or cost');
 await nav('Expenses');await page.getByRole('heading',{name:'Expenses',exact:true}).waitFor();
 await nav('Pricing');await page.getByRole('heading',{name:'Pricing',exact:true}).waitFor();
 await nav('Shows');await page.getByText('Fixture pin show',{exact:true}).waitFor();
 await nav('Today');await page.screenshot({path:artifacts+'/today.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:artifacts+'/mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Mobile page must fit without horizontal overflow');
 assert.deepEqual(errors,[],'Browser must not throw render/runtime exceptions');
 console.log(JSON.stringify({passed:true,upstreamRequests:calls.length,labelRequests,screenshots:artifacts,checked:['connect','sync','inventory cost/quantity/price','orders','packing join','thermal PDF/reprint','financial import/dedupe','legacy views','desktop/mobile']}));
}finally{
 await browser.close();await new Promise(resolve=>server.close(resolve));app.locals.db.close();
}
