# Ledger · Storybook Finds

A local sales and expense dashboard built with React, Express, and SQLite. Requires Node 24 (uses built-in `node:sqlite`).

```sh
npm ci --cache /workspace/.npm-cache
npm run dev
```

The server listens on port 3000. Override with `PORT`. Data persists in `data/ledger.sqlite`; override with `DB_PATH`. Back up the SQLite database using SQLite's backup facilities, or stop the server before copying the database and its WAL files together. Database files are ignored by Git.

```sh
npm run build
npm test
npm start
```

## Imports

Upload one CSV at a time with **Import CSV**. Imports validate completely before committing, with a 2 MB / 10,000 row limit. Three Whatnot export formats are detected automatically:

- **Weekly earnings**: `LEDGER_TRANSACTION_ID` identifies each entry. Positive `TRANSACTION_AMOUNT` is settled income after platform fees; negative entries become expenses (including giveaway shipping). Zero entries are retained for reconciliation. Fees are displayed separately and are not deducted twice. Positive cost-of-goods values become expenses. Blank or zero COGS is flagged as incomplete; operating balance is not final profit. Dates use `TRANSACTION_COMPLETED_AT_UTC`, not order placement or report week.
- **Daily overview**: estimated gross sales, net earnings and order counts are shown separately, by export date. They never create financial transactions. A new overview replaces matching dates rather than adding duplicates.
- **Wallet activity**: sales, tips, payouts, pending statuses and adjustments are retained as reference data only. Wallet records never create additional financial transactions, even for dates absent from weekly reports. To include those earnings in recorded income, upload the corresponding weekly report. Payouts and payout-failure refunds are transfers rather than expenses/revenue. Wallet dates use the dates printed in the export; its timezone is unspecified. Order IDs identify sales; other wallet events use a fingerprint of exported event fields because that format lacks transaction IDs. Identical fingerprints are skipped; retain originals for audit. Completed statuses cannot regress to processing.

Repeat Whatnot uploads skip duplicates; conflicting weekly ledger IDs fail the entire import for review. Import history shows added, skipped and updated counts. Whatnot rows are read-only in the transaction table; manual rows can be deleted.

Custom sales/expense CSVs use `date,description,category,amount` with YYYY-MM-DD dates, USD amounts and positive amounts of up to two decimal places. Select Sale or Expense in the import dialog. Custom files have no stable IDs and are **not deduplicated**.

## Scope

This is a single-workspace application without authentication. Keep it in the private development environment; add authentication and access controls before a public deployment. No bank connection or automatic Whatnot login is used. Source uploads are processed as data and not stored; normalized data is retained in SQLite. Export downloads the currently filtered financial transactions. Whatnot analytics include only uploaded periods, and missing weekly reports are not filled using estimates.
