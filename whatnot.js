import {parse} from 'csv-parse/sync';
import {createHash} from 'node:crypto';
import {isPinCategory} from './src/pins.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function cents(value,{optional=false}={}) {
  if(optional && (value===undefined || String(value).trim()==='')) return null;
  const text=String(value??'').trim().replace(/^\((.*)\)$/,'-$1').replace(/[$,]/g,'');
  if(!/^-?\d+(\.\d{1,2})?$/.test(text) || Math.abs(Number(text))>1e9) throw Error('Invalid USD amount.');
  return Math.round(Number(text)*100);
}
function isoDate(value){
 const text=String(value||'').trim();
 let date;
 if(/^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(text)) date=text.slice(0,10);
 else {
  const match=text.match(/^([A-Za-z]{3}) (\d{1,2}), (\d{4})(?:,|$)/);
  const month=match && ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[1]);
  if(!match || month<0) throw Error('Unrecognized report date.');
  date=`${match[3]}-${String(month+1).padStart(2,'0')}-${match[2].padStart(2,'0')}`;
 }
 if(!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Error('Invalid report date.');
 return date;
}
function count(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid report count.');return n;}
const empty=value=>value===undefined||value===null||String(value).trim()==='';
const optionalCount=value=>empty(value)?null:count(value);
const financialTypes=new Set(['ORDER_EARNINGS','SHIPPING_CHARGE','CARRIER_ADJUSTMENT','CARRIER_ADJUSTMENT_REFUND','ORDER_REFUND','ORDER_REFUND_SHIPPING_COSTS','APPEALED_ORDER_REFUND','APPEALED_ORDER_REFUND_SHIPPING_COSTS','TIP']);
function fee(row,...aliases){
 const amounts=aliases.filter(key=>!empty(row[key])).map(key=>cents(row[key]));
 if(amounts.some(value=>value<0))throw Error('Fees and cost of goods must not be negative.');
 if(new Set(amounts).size>1)throw Error('Conflicting fee columns.');
 return amounts[0]??0;
}
function ledgerCategory(row,amount){
 if(row.transaction_type==='TIP')return 'Tips';
 if(row.transaction_type==='SHIPPING_CHARGE')return 'Whatnot shipping';
 if(row.transaction_type==='CARRIER_ADJUSTMENT'||row.transaction_type==='CARRIER_ADJUSTMENT_REFUND')return 'Carrier adjustments';
 if(row.transaction_type.includes('REFUND'))return 'Whatnot refunds';
 return amount<0?'Giveaway shipping':row.product_category||'Whatnot sales';
}
export function parseUpload(buffer,type,validate,options={}){
 let columns=[];
 const records=parse(buffer,{columns:headers=>(columns=headers.map(h=>h.trim().toLowerCase())),skip_empty_lines:true,bom:true,trim:true});
 if((!records.length&&!options.allowEmpty)||records.length>10000)throw Error('Upload between 1 and 10,000 rows.');
 const header=records[0]||Object.fromEntries(columns.map(key=>[key,'']));
 const format='ledger_transaction_id' in header?'earnings':('estimated sales' in header||'estimated_sales' in header)?'overview':('created date' in header&&'transaction type' in header)?'wallet':'standard';
 if(options.reportType&&format!==(options.reportType==='seller_financial_report'?'earnings':'overview'))throw Error('The report columns do not match the requested report type.');
 if(options.reportType){
  const required=options.reportType==='seller_financial_report'
   ?['ledger_transaction_id','transaction_completed_at_utc','transaction_currency','transaction_type','transaction_amount']
   :['date','currency','estimated_sales','estimated_earnings'];
  for(const name of required)if(!columns.includes(name))throw Error(`The report is missing the required ${name} column.`);
 }
 const apiFinancial=options.reportType==='seller_financial_report'||['processing_fee','processing_fee_tax','commission_tax','quantity_sold'].some(key=>key in header);
 const rows=records.map((r,i)=>{try{
  if(format==='standard')return validate({...r,type:r.type||type});
  if(format==='earnings'){
   for(const field of ['ledger_transaction_id','transaction_completed_at_utc','transaction_currency','transaction_amount','transaction_type'])if(!r[field])throw Error(`Missing ${field}.`);
   if(r.transaction_currency!=='USD')throw Error('Only USD reports are supported.');
   if(!financialTypes.has(r.transaction_type))throw Error(`Unsupported earnings type: ${r.transaction_type}.`);
   const amount=cents(r.transaction_amount);
   const fees=fee(r,'commission_fee')+fee(r,'processing_fee','payment_processing_fee')+fee(r,'commission_tax','tax_on_commission_fee')+fee(r,'processing_fee_tax','tax_on_payment_processing_fee');
   const unitCogs=cents(r.cost_of_goods,{optional:true});
   if(unitCogs!==null&&unitCogs<0)throw Error('Fees and cost of goods must not be negative.');
   const quantity=apiFinancial&&r.transaction_type==='ORDER_EARNINGS'?optionalCount(r.quantity_sold):null;
   if(quantity===0)throw Error('Sold quantity must be positive.');
   // The API defines cost_of_goods per item. An absent quantity cannot be
   // assumed to be one: retain it as incomplete instead of understating cost.
   const cogs=apiFinancial?(r.transaction_type==='ORDER_EARNINGS'&&quantity!==null&&unitCogs!==null?unitCogs*quantity:null):unitCogs;
   if(cogs!==null&&!Number.isSafeInteger(cogs))throw Error('Cost of goods is too large.');
   return {key:'earnings:'+r.ledger_transaction_id,date:isoDate(r.transaction_completed_at_utc),orderDate:r.order_placed_at_utc?isoDate(r.order_placed_at_utc):null,orderId:r.order_id||null,description:r.listing_title||r.transaction_message||'Whatnot earnings',category:ledgerCategory(r,amount),cents:amount,fees,cogs,gross:cents(r.post_coupon_price,{optional:true}),kind:r.transaction_type,giveaway:r.buy_format?.toUpperCase()==='GIVEAWAY',...(apiFinancial?{currency:'USD',reportSchema:'seller-api',quantitySold:quantity,unitCogs}: {})};
  }
  if(format==='overview'){
   const apiOverview='estimated_sales' in r;
   if(apiOverview&&r.currency!=='USD')throw Error('Only USD reports are supported.');
   return {key:'overview:'+isoDate(r.date),date:isoDate(r.date),sales:cents(apiOverview?r.estimated_sales:r['estimated sales'],{optional:apiOverview}),earnings:cents(apiOverview?r.estimated_earnings:r['estimated earnings'],{optional:apiOverview}),orders:apiOverview?optionalCount(r.orders_count):count(r.orders),buyers:apiOverview?optionalCount(r.buyers_count):count(r.buyers),follows:apiOverview?optionalCount(r.follows_count):count(r.follows)};
  }
  const kind=r['transaction type'],status=r.status?.toLowerCase();
  if(!['SALES','TIP','PAYOUT','ADJUSTMENT'].includes(kind))throw Error(`Unsupported wallet type: ${kind}.`);
  if(!['completed','processing'].includes(status))throw Error(`Unsupported status: ${status}.`);
  const identity=kind==='SALES'&&r['order id']?'order:'+r['order id']:hash(JSON.stringify([kind,r['created date'],r.amount,r.message,r['listing id'],r['order id']]));
  return {key:'wallet:'+identity,date:isoDate(r['created date']),cents:cents(r.amount),kind,status,description:kind==='PAYOUT'?'Whatnot payout':r.message||kind,orderId:r['order id']||null};
 }catch(e){throw Error(`Row ${i+2}: ${e.message}`);}});
 return {format,rows};
}
export function parseSellerReport(buffer,reportType){
 if(!['seller_financial_report','analytics_overview_report'].includes(reportType))throw Error('Unsupported Seller API report type.');
 return parseUpload(buffer,'sale',()=>{throw Error('Unexpected report columns.');},{reportType,allowEmpty:true});
}
function reconcileEarnings(existing,incoming){
 for(const key of ['date','cents','kind'])if(existing[key]!==incoming[key])return null;
 if((existing.currency||'USD')!==(incoming.currency||'USD'))return null;
 if(existing.orderId&&incoming.orderId&&existing.orderId!==incoming.orderId)return null;
 // Older CSV uploads must never replace a richer API record. The stable
 // ledger ID still deduplicates both sources, including renamed downloads.
 if(existing.reportSchema==='seller-api'&&incoming.reportSchema!=='seller-api')return existing;
 for(const key of ['cogs','gross']){
  if(existing[key]!=null&&incoming[key]!=null&&existing[key]!==incoming[key]){
   // The old parser retained one unit of cost; the API includes quantity.
   if(key!=='cogs'||existing.reportSchema==='seller-api'||incoming.reportSchema!=='seller-api'||existing.cogs!==incoming.unitCogs)return null;
  }
 }
 if(existing.reportSchema==='seller-api'&&incoming.reportSchema==='seller-api'&&existing.fees!==incoming.fees)return null;
 if(existing.reportSchema!=='seller-api'&&incoming.reportSchema!=='seller-api'&&existing.fees!==incoming.fees)return null;
 const merged={...existing,...incoming};
 for(const key of ['orderDate','orderId','cogs','gross'])if(incoming[key]==null&&existing[key]!=null)merged[key]=existing[key];
 return merged;
}
export function setupWhatnot(db){
 db.exec('CREATE TABLE IF NOT EXISTS whatnot_records (source_key TEXT PRIMARY KEY, format TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, format TEXT NOT NULL, imported INTEGER NOT NULL, skipped INTEGER NOT NULL, updated INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 const write=db.prepare('INSERT INTO whatnot_records(source_key,format,payload) VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET payload=excluded.payload');
 const read=db.prepare('SELECT payload FROM whatnot_records WHERE source_key=?');
 const fingerprint=row=>hash(JSON.stringify([row.type,row.date,row.description.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase(),isPinCategory(row.category)?'pins':row.category.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase(),row.cents]));
 return {
  importReport({format,rows},filename,save){
   let imported=0,skipped=0,updated=0;
   const known=new Map();
   if(format==='standard')for(const row of [...db.prepare('SELECT * FROM transactions').all(),...this.getTransactions()]){
    const key=fingerprint(row);known.set(key,[...(known.get(key)||[]),row]);
   }
   db.exec('BEGIN');
   try{
    for(const row of rows){
     if(format==='standard'){
      const key=fingerprint(row);
      const matches=known.get(key);
      if(matches){
        if(row.quantity!=null){
          if(matches.length!==1)throw Error('Multiple matching pin purchases exist. Edit their quantities individually.');
          const existing=matches[0];
          if(existing.quantity!=null&&existing.quantity!==row.quantity)throw Error('A matching pin purchase has a different quantity. Edit the saved quantity instead; no duplicate was added.');
          if(existing.quantity==null){
            db.prepare('UPDATE transactions SET category=?,quantity=? WHERE id=?').run('Pins',row.quantity,existing.id);
            existing.category='Pins';existing.quantity=row.quantity;updated++;continue;
          }
        }
        skipped++;continue;
      }
      const result=save(row);known.set(key,[{...row,id:Number(result.lastInsertRowid)}]);imported++;continue;
     }
     const existing=read.get(row.key);let serialized=JSON.stringify(row);
     if(existing){if(existing.payload===serialized){skipped++;continue;}
      if(format==='earnings'){
       const reconciled=reconcileEarnings(JSON.parse(existing.payload),row);
       if(!reconciled)throw Error('An existing earnings ID has conflicting values; no rows were imported.');
       serialized=JSON.stringify(reconciled);
       if(existing.payload===serialized){skipped++;continue;}
      }
      if(format==='wallet'&&JSON.parse(existing.payload).status==='completed'&&row.status==='processing'){skipped++;continue;}
      updated++;
     }else imported++;
     write.run(row.key,format,serialized);
    }
    db.prepare('INSERT INTO imports(filename,format,imported,skipped,updated) VALUES(?,?,?,?,?)').run(filename.slice(0,200),format,imported,skipped,updated);
    db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   return {format,imported,skipped,updated};
  },
  getRecords(){return db.prepare('SELECT format,payload FROM whatnot_records').all().map(r=>({format:r.format,...JSON.parse(r.payload)}));},
  getTransactions(){return this.getRecords().filter(r=>r.format==='earnings').flatMap(r=>{
   const transactions=[];
   if(r.cents!==0)transactions.push({id:r.key,type:r.cents<0?'expense':'sale',date:r.date,description:r.description,category:r.category,cents:Math.abs(r.cents),source:'Whatnot',orderId:r.orderId});
   if(r.cogs>0)transactions.push({id:r.key+':cogs',type:'expense',date:r.date,description:'Cost of goods: '+r.description,category:'Cost of goods',cents:r.cogs,source:'Whatnot',orderId:r.orderId});
   return transactions;
  });},
  summary(){const records=this.getRecords(),earnings=records.filter(r=>r.format==='earnings'),overview=records.filter(r=>r.format==='overview'),wallet=records.filter(r=>r.format==='wallet');
   return {earnings:{rows:earnings.length,fees:earnings.reduce((s,r)=>s+r.fees,0),gross:earnings.reduce((s,r)=>s+(r.gross||0),0),net:earnings.reduce((s,r)=>s+r.cents,0),missingCogs:earnings.filter(r=>!r.giveaway&&r.kind==='ORDER_EARNINGS'&&!r.cogs).length,zeroRows:earnings.filter(r=>r.cents===0).length},overview,wallet:{rows:wallet.length,pending:wallet.filter(r=>r.status==='processing'&&['SALES','TIP'].includes(r.kind)).reduce((s,r)=>s+r.cents,0),payouts:wallet.filter(r=>r.status==='completed'&&r.kind==='PAYOUT').reduce((s,r)=>s+Math.abs(r.cents),0),adjustments:wallet.filter(r=>r.kind==='ADJUSTMENT').length,records:wallet},imports:db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 20').all()};
  }
 };
}
