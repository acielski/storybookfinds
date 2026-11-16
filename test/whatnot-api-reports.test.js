import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {parseUpload,parseSellerReport,setupWhatnot} from '../whatnot.js';

const financialHeaders=['ledger_transaction_id','transaction_completed_at_utc','order_placed_at_utc','transaction_currency','transaction_type','transaction_amount','order_id','listing_title','transaction_message','product_category','buy_format','post_coupon_price','commission_fee','commission_tax','processing_fee','processing_fee_tax','cost_of_goods','quantity_sold'];
const csv=(headers,rows)=>[headers.join(','),...rows.map(row=>headers.map(key=>'"'+String(row[key]??'').replaceAll('"','""')+'"').join(','))].join('\n');
const financial=(...rows)=>Buffer.from(csv(financialHeaders,rows));
const order={ledger_transaction_id:'ledger-1',transaction_completed_at_utc:'2026-11-01T14:30:00.000Z',order_placed_at_utc:'2026-10-31T20:00:00.000Z',transaction_currency:'USD',transaction_type:'ORDER_EARNINGS',transaction_amount:'8.45',order_id:'order-1',listing_title:'Disney pin',product_category:'Pins',buy_format:'auction',post_coupon_price:'10.00',commission_fee:'0.80',commission_tax:'0.10',processing_fee:'0.70',processing_fee_tax:'0.05',cost_of_goods:'2.00',quantity_sold:'3'};
const legacyHeaders=['LEDGER_TRANSACTION_ID','TRANSACTION_COMPLETED_AT_UTC','ORDER_PLACED_AT_UTC','TRANSACTION_CURRENCY','TRANSACTION_TYPE','TRANSACTION_AMOUNT','ORDER_ID','LISTING_TITLE','PRODUCT_CATEGORY','BUY_FORMAT','POST_COUPON_PRICE','COMMISSION_FEE','TAX_ON_COMMISSION_FEE','PAYMENT_PROCESSING_FEE','TAX_ON_PAYMENT_PROCESSING_FEE','COST_OF_GOODS'];
function legacy(){
 return parseUpload(Buffer.from(legacyHeaders.join(',')+'\nledger-1,2026-11-01 14:30:00,2026-10-31 20:00:00,USD,ORDER_EARNINGS,8.45,order-1,Disney pin,Pins,AUCTION,10.00,0.80,0.10,0.70,0.05,2.00'),'sale',()=>{throw Error('Wrong format');});
}
function withStore(work){const db=new DatabaseSync(':memory:');try{return work(setupWhatnot(db));}finally{db.close();}}

test('API financial reports retain settled amounts, map current fee names, and allocate per-item costs by quantity',()=>withStore(store=>{
 const report=parseSellerReport(financial(order),'seller_financial_report');
 assert.equal(report.rows[0].date,'2026-11-01');
 assert.equal(report.rows[0].orderDate,'2026-10-31');
 assert.equal(report.rows[0].fees,165);
 assert.equal(report.rows[0].unitCogs,200);
 assert.equal(report.rows[0].cogs,600);
 assert.equal(report.rows[0].quantitySold,3);
 store.importReport(report,'api-financial.csv');
 const entries=store.getTransactions();
 assert.equal(entries.filter(r=>r.type==='sale').reduce((sum,r)=>sum+r.cents,0),845);
 assert.equal(entries.filter(r=>r.type==='expense').reduce((sum,r)=>sum+r.cents,0),600);
 assert.equal(store.summary().earnings.net,845); // Fees are informational, never subtracted twice.
 assert.equal(store.summary().earnings.fees,165);
 assert.equal(store.summary().earnings.missingCogs,0);
}));

test('charges, refunds, and reversals preserve the signed ledger total without duplicating order income',()=>withStore(store=>{
 const kinds=[['SHIPPING_CHARGE','-1.00'],['CARRIER_ADJUSTMENT','-2.00'],['CARRIER_ADJUSTMENT_REFUND','0.50'],['ORDER_REFUND','-3.00'],['ORDER_REFUND_SHIPPING_COSTS','-0.75'],['APPEALED_ORDER_REFUND','1.00'],['APPEALED_ORDER_REFUND_SHIPPING_COSTS','0.25'],['TIP','2.00']];
 const report=parseSellerReport(financial(...kinds.map(([kind,amount],index)=>({...order,ledger_transaction_id:'adjustment-'+index,transaction_type:kind,transaction_amount:amount,listing_title:'',cost_of_goods:'',quantity_sold:'',post_coupon_price:'',commission_fee:'',commission_tax:'',processing_fee:'',processing_fee_tax:''}))),'seller_financial_report');
 store.importReport(report,'adjustments.csv');
 const entries=store.getTransactions();
 const balance=entries.reduce((sum,r)=>sum+(r.type==='sale'?r.cents:-r.cents),0);
 assert.equal(balance,-300);
 assert.equal(store.summary().earnings.net,-300);
 assert.equal(entries.length,kinds.length);
 assert.equal(entries.find(r=>r.id==='earnings:adjustment-3').category,'Whatnot refunds');
 assert.equal(entries.find(r=>r.id==='earnings:adjustment-3').type,'expense');
 assert.equal(store.summary().earnings.missingCogs,0);
 assert.equal(store.importReport(report,'renamed.csv').skipped,kinds.length);
}));

test('API and legacy overlap enriches the existing ledger ID and never regresses its quantity-aware costs',()=>withStore(store=>{
 store.importReport(legacy(),'old-weekly.csv');
 const report=parseSellerReport(financial({...order,listing_title:'Updated pin title'}),'seller_financial_report');
 const result=store.importReport(report,'api.csv');
 assert.deepEqual(result,{format:'earnings',imported:0,skipped:0,updated:1});
 assert.equal(store.summary().earnings.rows,1);
 assert.equal(store.getTransactions().filter(row=>row.type==='sale').length,1);
 assert.equal(store.getTransactions().find(row=>row.category==='Cost of goods').cents,600);
 assert.equal(store.importReport(report,'api-retry.csv').skipped,1);
 assert.equal(store.importReport(legacy(),'old-weekly-again.csv').skipped,1);
 assert.equal(store.getTransactions().find(row=>row.category==='Cost of goods').cents,600);
}));

test('amount, currency, and same-schema cost conflicts roll back the whole financial import',()=>withStore(store=>{
 const report=parseSellerReport(financial(order),'seller_financial_report');
 store.importReport(report,'initial.csv');
 const conflict=parseSellerReport(financial({...order,ledger_transaction_id:'new-first'},{...order,transaction_amount:'99.00'}),'seller_financial_report');
 assert.throws(()=>store.importReport(conflict,'conflict.csv'),/conflicting/);
 assert.equal(store.summary().earnings.rows,1);
 assert.throws(()=>store.importReport({format:'earnings',rows:[{...report.rows[0],currency:'EUR'}]},'currency.csv'),/conflicting/);
 assert.throws(()=>store.importReport(parseSellerReport(financial({...order,cost_of_goods:'3.00'}),'seller_financial_report'),'cost-conflict.csv'),/conflicting/);
 assert.equal(store.getTransactions().find(row=>row.category==='Cost of goods').cents,600);
}));

test('nullable API overview values remain unknown and never become financial entries',()=>withStore(store=>{
 const report=parseSellerReport(Buffer.from('date,currency,estimated_sales,estimated_earnings,orders_count,buyers_count,follows_count\n2026-11-01,USD,,8.45,,1,0'),'analytics_overview_report');
 assert.deepEqual(report.rows[0],{key:'overview:2026-11-01',date:'2026-11-01',sales:null,earnings:845,orders:null,buyers:1,follows:0});
 store.importReport(report,'overview.csv');
 assert.equal(store.getTransactions().length,0);
 assert.equal(store.summary().overview[0].sales,null);
}));

test('API reports reject unsupported currencies and types, incorrect schema, negative counts, and conflicting aliases',()=>{
 assert.throws(()=>parseSellerReport(financial({...order,transaction_currency:'EUR'}),'seller_financial_report'),/Only USD/);
 assert.throws(()=>parseSellerReport(Buffer.from('date,currency,estimated_sales,estimated_earnings\n2026-11-01,EUR,10.00,8.00'),'analytics_overview_report'),/Only USD/);
 assert.throws(()=>parseSellerReport(financial({...order,transaction_type:'UNKNOWN'}),'seller_financial_report'),/Unsupported earnings type/);
 assert.throws(()=>parseSellerReport(financial({...order,quantity_sold:'-1'}),'seller_financial_report'),/Invalid report count/);
 assert.throws(()=>parseSellerReport(financial({...order,quantity_sold:'0'}),'seller_financial_report'),/positive/);
 assert.throws(()=>parseSellerReport(financial(order),'analytics_overview_report'),/columns/);
 assert.throws(()=>parseSellerReport(financial(order),'unrecognized_report'),/Unsupported Seller API/);
 assert.throws(()=>parseSellerReport(Buffer.from(csv([...financialHeaders,'payment_processing_fee'],[{...order,payment_processing_fee:'9.99'}])),'seller_financial_report'),/Conflicting fee/);
});

test('missing sold quantity leaves costs incomplete; empty completed API reports are valid',()=>withStore(store=>{
 const report=parseSellerReport(financial({...order,quantity_sold:''}),'seller_financial_report');
 assert.equal(report.rows[0].unitCogs,200);
 assert.equal(report.rows[0].cogs,null);
 store.importReport(report,'unknown-quantity.csv');
 assert.equal(store.summary().earnings.missingCogs,1);
 const empty=parseSellerReport(financial(),'seller_financial_report');
 assert.deepEqual(empty,{format:'earnings',rows:[]});
 assert.equal(store.importReport(empty,'no-transactions.csv').imported,0);
}));

test('completed empty API reports must retain every essential column before being accepted',()=>{
 const requiredFinancial=['ledger_transaction_id','transaction_completed_at_utc','transaction_currency','transaction_type','transaction_amount'];
 const requiredOverview=['date','currency','estimated_sales','estimated_earnings'];
 assert.throws(()=>parseSellerReport(Buffer.from('ledger_transaction_id\n'),'seller_financial_report'),/required transaction_completed_at_utc column/);
 for(const missing of requiredFinancial){
  const headers=requiredFinancial.filter(name=>name!==missing);
  assert.throws(()=>parseSellerReport(Buffer.from(headers.join(',')+'\n'),'seller_financial_report'),/columns|column/);
 }
 for(const missing of requiredOverview){
  const headers=requiredOverview.filter(name=>name!==missing);
  assert.throws(()=>parseSellerReport(Buffer.from(headers.join(',')+'\n'),'analytics_overview_report'),/columns|column/);
 }
 assert.deepEqual(parseSellerReport(Buffer.from(requiredFinancial.join(',')+'\n'),'seller_financial_report'),{format:'earnings',rows:[]});
 assert.deepEqual(parseSellerReport(Buffer.from(requiredOverview.join(',')+'\n'),'analytics_overview_report'),{format:'overview',rows:[]});
});
