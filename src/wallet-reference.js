// Wallet CSVs are a historical reference. API sync does not refresh these rows.
// Input records are normalized wallet rows already filtered to the selected period.
export function summarizeWalletReference(records = []) {
  const sorted = records.slice().sort((a, b) => b.date.localeCompare(a.date));
  const processingEarnings = sorted.filter(row => row.status === 'processing' && ['SALES', 'TIP'].includes(row.kind));
  const completedPayouts = sorted.filter(row => row.status === 'completed' && row.kind === 'PAYOUT');

  return {
    records: sorted,
    recordCount: sorted.length,
    earliestRecordDate: sorted.at(-1)?.date ?? null,
    latestRecordDate: sorted[0]?.date ?? null,
    processingEarningsCents: sorted.length ? processingEarnings.reduce((sum, row) => sum + row.cents, 0) : null,
    processingEarningsCount: processingEarnings.length,
    completedPayoutCents: completedPayouts.length ? completedPayouts.reduce((sum, row) => sum + Math.abs(row.cents), 0) : null,
    completedPayoutCount: completedPayouts.length,
  };
}
