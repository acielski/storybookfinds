export function isPinCategory(category){
  return ['pins','pins & inventory'].includes(String(category||'').trim().toLowerCase());
}
export function pinMetrics(expenses){
  const purchases=expenses.filter(row=>row.type==='expense'&&isPinCategory(row.category));
  const complete=purchases.filter(row=>Number.isSafeInteger(row.quantity)&&row.quantity>0);
  const quantity=complete.reduce((sum,row)=>sum+row.quantity,0);
  const costCents=complete.reduce((sum,row)=>sum+row.cents,0);
  return {quantity,costCents,averageCents:quantity?costCents/quantity:null,missingQuantity:purchases.length-complete.length};
}
