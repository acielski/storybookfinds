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
 if(/^\d{4}-\d{2}-\d{2}( |$)/.test(text)) date=text.slice(0,10);
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
export function parseUpload(buffer,type,validate){
 const records=parse(buffer,{columns:headers=>headers.map(h=>h.trim().toLowerCase()),skip_empty_lines:true,bom:true,trim:true});
 if(!records.length||records.length>10000)throw Error('Upload between 1 and 10,000 rows.');
 const header=records[0];
 const format='ledger_transaction_id' in header?'earnings':'estimated sales' in header?'overview':('created date' in header&&'transaction type' in header)?'wallet':'standard';
 const rows=records.map((r,i)=>{try{
  if(format==='standard')return validate({...r,type:r.type||type});
  if(format==='earnings'){
   for(const field of ['ledger_transaction_id','transaction_completed_at_utc','transaction_currency','transaction_amount','transaction_type'])if(!r[field])throw Error(`Missing ${field}.`);
   if(r.transaction_currency!=='USD')throw Error('Only USD reports are supported.');
   if(!['ORDER_EARNINGS','TIP'].includes(r.transaction_type))throw Error(`Unsupported earnings type: ${r.transaction_type}.`);
   const amount=cents(r.transaction_amount);
   const fees=['commission_fee','payment_processing_fee','tax_on_commission_fee','tax_on_payment_processing_fee'].reduce((s,k)=>s+(cents(r[k],{optional:true})||0),0);
   const cogs=cents(r.cost_of_goods,{optional:true});
   if(fees<0 || (cogs!==null&&cogs<0))throw Error('Fees and cost of goods must not be negative.');
   return {key:'earnings:'+r.ledger_transaction_id,date:isoDate(r.transaction_completed_at_utc),orderDate:r.order_placed_at_utc?isoDate(r.order_placed_at_utc):null,orderId:r.order_id||null,description:r.listing_title||r.transaction_message||'Whatnot earnings',category:r.transaction_type==='TIP'?'Tips':amount<0?'Giveaway shipping':r.product_category||'Whatnot sales',cents:amount,fees,cogs,gross:cents(r.post_coupon_price,{optional:true}),kind:r.transaction_type,giveaway:r.buy_format==='GIVEAWAY'};
  }
  if(format==='overview')return {key:'overview:'+isoDate(r.date),date:isoDate(r.date),sales:cents(r['estimated sales']),earnings:cents(r['estimated earnings']),orders:count(r.orders),buyers:count(r.buyers),follows:count(r.follows)};
  const kind=r['transaction type'],status=r.status?.toLowerCase();
  if(!['SALES','TIP','PAYOUT','ADJUSTMENT'].includes(kind))throw Error(`Unsupported wallet type: ${kind}.`);
  if(!['completed','processing'].includes(status))throw Error(`Unsupported status: ${status}.`);
  const identity=kind==='SALES'&&r['order id']?'order:'+r['order id']:hash(JSON.stringify([kind,r['created date'],r.amount,r.message,r['listing id'],r['order id']]));
  return {key:'wallet:'+identity,date:isoDate(r['created date']),cents:cents(r.amount),kind,status,description:kind==='PAYOUT'?'Whatnot payout':r.message||kind,orderId:r['order id']||null};
 }catch(e){throw Error(`Row ${i+2}: ${e.message}`);}});
 return {format,rows};
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
     const existing=read.get(row.key),serialized=JSON.stringify(row);
     if(existing){if(existing.payload===serialized){skipped++;continue;}
      if(format==='earnings')throw Error('An existing earnings ID has conflicting values; no rows were imported.');
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
