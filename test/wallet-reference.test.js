import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {summarizeWalletReference} from '../src/wallet-reference.js';
import {parseUpload,parseSellerReport,setupWhatnot} from '../whatnot.js';

test('missing wallet data remains unavailable rather than claiming a zero payout or current balance',()=>{
 const summary=summarizeWalletReference([]);
 assert.equal(summary.recordCount,0);
 assert.equal(summary.completedPayoutCents,null);
 assert.equal(summary.processingEarningsCents,null);
 assert.equal(summary.earliestRecordDate,null);
 assert.equal(summary.latestRecordDate,null);
});

test('wallet reference distinguishes payout-entry amounts, processing income, and unrelated adjustments',()=>{
 const records=[
  {key:'payout-1',date:'2026-09-02',kind:'PAYOUT',status:'completed',cents:-10000},
  {key:'adjustment',date:'2026-09-04',kind:'ADJUSTMENT',status:'completed',cents:2000},
  {key:'payout-pending',date:'2026-09-05',kind:'PAYOUT',status:'processing',cents:-5000},
  {key:'sale',date:'2026-09-01',kind:'SALES',status:'processing',cents:900},
  {key:'tip',date:'2026-09-03',kind:'TIP',status:'processing',cents:100},
  {key:'settled',date:'2026-09-06',kind:'SALES',status:'completed',cents:500},
 ];
 const original=structuredClone(records),summary=summarizeWalletReference(records);
 assert.equal(summary.completedPayoutCents,10000);
 assert.equal(summary.completedPayoutCount,1);
 assert.equal(summary.processingEarningsCents,1000);
 assert.equal(summary.processingEarningsCount,2);
 assert.equal(summary.recordCount,6);
 assert.equal(summary.earliestRecordDate,'2026-09-01');
 assert.equal(summary.latestRecordDate,'2026-09-06');
 assert.deepEqual(records,original,'Summarizing cannot rewrite imported amounts, statuses, or order');
});

test('a selected period without completed payout entries does not imply that no payouts occurred',()=>{
 const selected=[{key:'sale',date:'2026-11-01',kind:'SALES',status:'completed',cents:1000}];
 const summary=summarizeWalletReference(selected);
 assert.equal(summary.recordCount,1);
 assert.equal(summary.completedPayoutCents,null);
 assert.equal(summary.completedPayoutCount,0);
 assert.equal(summary.processingEarningsCents,0);
 assert.equal(summary.earliestRecordDate,'2026-11-01');
});

test('API financial reports cannot silently refresh legacy wallet snapshots or count payouts as earnings',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const store=setupWhatnot(db);
  const wallet='Created Date,Amount,Order ID,Message,Status,Transaction Type\n"Sep 2, 2026, 2:00:00 PM",-100.00,,Payout,completed,PAYOUT\n"Sep 3, 2026, 2:00:00 PM",10.00,order-1,Sale,processing,SALES';
  const parsed=parseUpload(Buffer.from(wallet),'sale',()=>assert.fail('Expected wallet format'));
  store.importReport(parsed,'wallet-history.csv');
  const before=store.summary().wallet.records;
  const report='ledger_transaction_id,transaction_completed_at_utc,transaction_currency,transaction_type,transaction_amount,quantity_sold\nledger-1,2026-09-04T12:00:00Z,USD,ORDER_EARNINGS,9.00,1\n';
  store.importReport(parseSellerReport(Buffer.from(report),'seller_financial_report'),'api-financial.csv');
  assert.deepEqual(store.summary().wallet.records,before);
  assert.equal(summarizeWalletReference(store.summary().wallet.records).completedPayoutCents,10000);
  assert.equal(summarizeWalletReference(store.summary().wallet.records).processingEarningsCents,1000);
  assert.equal(store.getTransactions().length,1);
  assert.equal(store.getTransactions()[0].cents,900);
  const repeated=store.importReport(parsed,'wallet-history-again.csv');
  assert.equal(repeated.skipped,2);
  assert.deepEqual(store.summary().wallet.records,before);
 }finally{db.close();}
});
