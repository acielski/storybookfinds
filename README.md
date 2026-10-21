# Storybook Finds · Your shop journal

A whimsical dashboard for a Disney pin shop, built with React, Express, and SQLite. Requires Node 24 (uses built-in `node:sqlite`).

**Publishing:** follow [the step-by-step Vercel + Supabase checklist](docs/DEPLOY.md). Run the SQL migration, create an app login, and add the two Vercel environment variables before using the published app.

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

## Expense sheet

Open **Expenses** to enter Date, Item, Category, Cost, and Pin quantity directly into a spreadsheet-style grid. Tab between cells, add or remove rows, and use **Save expenses** to save multiple rows together. Blank rows are ignored; partial rows must be completed before saving. Categories support suggested options or your own text. Unsaved totals are displayed in USD. Drafts remain while switching tabs but are not retained after a page reload.

Choose **Pins** for inventory purchases. Enter a positive whole-number quantity and the total cost of that purchase. The sheet calculates cost per pin immediately; the Expense book retains the quantity and cost per pin. Use the pencil beside a saved quantity to add or correct it without entering the purchase twice. The dashboard's pin metrics use the selected date period: total known pin quantity, total pin purchase spending, and a weighted average (cost of purchases with quantities ÷ their combined quantity), rather than the average of each row's unit price. Shipping and other categories are excluded. Old “Pins & inventory” entries are recognized; missing quantities are flagged and excluded from the average until supplied. No quantities are guessed.

Custom Pins expense CSVs require a `quantity` column. Repeated matching purchases skip duplicates; adding a quantity to an existing legacy purchase updates it without adding its cost again. A conflicting nonempty quantity fails the whole file for review; correct it with the saved-row pencil. Quantity survives CSV exports, SQLite restarts and Supabase snapshots. Existing databases upgrade automatically; no new Supabase SQL migration is needed.

Saved rows appear in the searchable, paginated Expense book and can be exported. Imported Whatnot entries are read-only; manual/custom expenses can be deleted. The expense sheet uses the same duplicate protection as custom CSV imports, so repeating a save after a network interruption will skip records already present. Inventory purchases are recorded as expenses; the app does not track inventory valuation or automatically allocate inventory purchases to individual sold pins.

## Imports

Use **Import CSV** to select up to **20 CSV files at once**. Each file has a 2 MB / 10,000 row limit. The results screen shows added, skipped, updated, and failed counts for each file. Every file is validated and committed atomically; one failed file does not stop other valid files. Repeating a batch safely skips records already present, including records imported by earlier files in the same batch. Oversized batches or files are rejected by the UI before importing. In cloud mode the browser uploads one file per request (under Vercel's 4.5 MB request limit), with progress and per-file results. The local batch endpoint remains supported. Each file is committed independently; retries skip existing data. Three Whatnot export formats are detected automatically:

- **Weekly earnings**: `LEDGER_TRANSACTION_ID` identifies each entry. Positive `TRANSACTION_AMOUNT` is settled income after platform fees; negative entries become expenses (including giveaway shipping). Zero entries are retained for reconciliation. Fees are displayed separately and are not deducted twice. Positive cost-of-goods values become expenses. Blank or zero COGS is flagged as incomplete; operating balance is not final profit. Dates use `TRANSACTION_COMPLETED_AT_UTC`, not order placement or report week.
- **Daily overview**: estimated gross sales, net earnings and order counts are shown separately, by export date. They never create financial transactions. A new overview replaces matching dates rather than adding duplicates.
- **Wallet activity**: sales, tips, payouts, pending statuses and adjustments are retained as reference data only. Wallet records never create additional financial transactions, even for dates absent from weekly reports. To include those earnings in recorded income, upload the corresponding weekly report. Payouts and payout-failure refunds are transfers rather than expenses/revenue. Wallet dates use the dates printed in the export; its timezone is unspecified. Order IDs identify sales; other wallet events use a fingerprint of exported event fields because that format lacks transaction IDs. Identical fingerprints are skipped; retain originals for audit. Completed statuses cannot regress to processing.

Repeat Whatnot uploads skip duplicates; conflicting weekly ledger IDs fail the entire import for review. Import history shows added, skipped and updated counts. Whatnot rows are read-only in the transaction table; manual rows can be deleted.

Custom sales/expense CSVs use `date,description,category,amount` with YYYY-MM-DD dates, USD amounts and positive amounts of up to two decimal places. Select Sale or Expense in the import dialog. When a CSV contains a `type` column, its sale/expense values take priority over the dialog selection, allowing mixed transaction exports to be re-imported safely. Custom rows are deduplicated against existing manual/custom transactions and imported Whatnot financial transactions using type, date, amount in cents, and normalized description/category (Unicode normalization, case-insensitive, collapsed whitespace). This also protects data imported before batch support. Identical rows within the same file are skipped. Custom CSVs have no stable transaction IDs: two genuine transactions with the same identifying fields cannot be distinguished, so record those manually instead. Deleting a manual/custom transaction allows it to be imported again; no existing duplicates are automatically deleted.

## Scope

Without Supabase settings, local development uses the existing SQLite database without authentication; keep this mode private. On Vercel, both `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are required. Missing configuration fails closed rather than falling back to a temporary SQLite database. Sign-in uses Supabase email/password authentication; every API request verifies the user session. SQL row-level policies restrict each account to its own workspace. The app never needs a service-role key. Disable public signups in Supabase and create the app user through its dashboard.

In Supabase mode, durable records and import history are stored as a versioned JSON workspace in PostgreSQL. Each request uses an isolated in-memory SQLite engine for the existing validation/import logic, then commits changes through an atomic Supabase function. Optimistic version checks return HTTP 409 on overlapping writes instead of losing data. Imported records and transaction IDs survive function restarts. This design suits the current small-business dataset; large multi-user reporting or inventory systems should move to normalized relational tables. Original local SQLite files are not automatically migrated; retain them and re-import CSVs as explained in the deployment checklist.

For local Supabase testing, copy `.env.example` to `.env.local`, enter the two project settings, and restart `npm run dev`. Both files with real values and Vercel metadata are ignored by Git. Never put passwords or privileged keys in source code. No bank connection or automatic Whatnot login is used. Source uploads are processed as data and not stored; normalized data is retained in SQLite. Export downloads the currently filtered financial transactions. Whatnot analytics include only uploaded periods, and missing weekly reports are not filled using estimates.

Username sign-in is available as an optional server-configured alias for the existing shop account. See the username section in [the deployment checklist](docs/DEPLOY.md). Set `SHOP_USERNAME` and `SHOP_LOGIN_EMAIL` in Vercel and redeploy; no additional Supabase keys or SQL are required. Email sign-in remains supported.

## Calculator and bundle pricing

Open **Pricing** from the sidebar. The bundle builder starts with four empty pin-price slots; add or remove slots as needed. Enter prices in USD and select a discount preset or enter your own percentage from 0–100 (up to two decimal places). Blank slots are ignored. The original total, discount, and final bundle price update immediately. Discount amounts round to the nearest cent before subtraction. **Copy bundle quote** copies the prices and discount for sharing. **Start over** restores four blank slots and a 10% discount.

The basic calculator supports addition, subtraction, multiplication, division, decimals, percentages, sign changes, clear, backspace, and keyboard controls while focused inside the calculator. Like a basic handheld calculator, chained operations are evaluated as entered. With + or −, the percent key calculates a percentage of the first number (200 − 10% = 180); with multiplication it divides the current input by 100 (200 × 10% = 20).

Pricing is a scratchpad: navigating between tabs retains the current calculations, but reloading the page clears them. Quotes do not create sales or change recorded expenses.
