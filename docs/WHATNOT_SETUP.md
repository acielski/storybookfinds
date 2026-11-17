# Connect Storybook Finds to Whatnot

You need a **Whatnot Seller API token stored in Vercel**. You do not need to create a Vercel API token.

Work through one box at a time. Keep secret values in the dashboards; do not paste them into GitHub or chat.

## 1. Prepare the database — once

1. Open the shop's Supabase project.
2. Open **SQL Editor → New query**.
3. Paste the complete contents of [002_shared_workspaces.sql](../supabase/migrations/002_shared_workspaces.sql).
4. Click **Run**. It is safe to rerun this migration.
5. Open another new query.
6. Paste [003_seller_api.sql](../supabase/migrations/003_seller_api.sql).
7. Click **Run**.

**Done when:** both queries succeed. Existing expenses and financial imports stay in place. No reset or delete is needed. Migration 001 must already exist from the original app setup.

## 2. Make the Whatnot token

1. Open [Whatnot → Developer dashboard → Personal access tokens](https://www.whatnot.com/dashboard/developer?tab=tokens).
2. Click **Generate new token**.
3. Name it `Storybook Finds`.
4. Choose its expiration. Note the renewal date if you choose an expiring token.
5. Enable report write access, inventory read/write access, order read access, shipment read/write access, show read access, and customer read access.
6. Copy the token into your password manager. Whatnot shows it only once.

Permission names are `write:reports`, `write:inventory`, `read:orders`, `write:shipments`, `read:shows`, and `read:customers`; write permissions include their corresponding reads. Exact label-generation eligibility must be confirmed with your account. Customer-document access may require Whatnot app approval. Use the app's actionable permission errors if a capability is denied; never expand unrelated permissions to work around a setup error.

**Done when:** you have saved the token privately.

## 3. Collect the two account IDs

1. Open Whatnot's [Get current user API reference](https://developers.whatnot.com/whatnot-seller-api/tag/users/get/users/me).
2. Use **Test Request** with your token in Bearer authentication.
3. Copy the returned `id`. This is your **Whatnot seller ID**. Keep the token out of request URLs.
4. In Supabase, open **Authentication → Users**.
5. Open the account that owns your shop workspace.
6. Copy its **User UID**. This is the **workspace owner ID**; an editor's ID is different.

**Done when:** you have both IDs. The app checks both before using the connection.

## 4. Add three settings in Vercel

1. Open the **Storybook Finds** Vercel project.
2. Open **Settings → Environment Variables**.
3. Add the following names and values, one at a time:

| Name | Value |
| --- | --- |
| `WHATNOT_API_TOKEN` | The Whatnot token you saved |
| `WHATNOT_SELLER_ID` | The seller `id` returned by Whatnot |
| `WHATNOT_WORKSPACE_OWNER_ID` | The owner's Supabase User UID |

4. Choose **Production** for the live shop. Store the API token as **Secret**.
5. Click **Save** after each variable.
6. Deploy the reviewed GitHub change, or use **Deployments → latest deployment → Redeploy** if the code is already deployed.

**Done when:** the deployment succeeds. Environment changes apply to new deployments.

For testing, use the existing separate development Vercel/Supabase projects, their test workspace owner, and test-appropriate seller credentials. Never point previews at the production database. The app preserves its existing preview/development database guard.

## 5. Connect and update the app — once

1. Sign in to Storybook Finds as the shop owner.
2. Open **Settings**.
3. Click **Verify connection**.
4. Check that the displayed seller is your shop.
5. Click **Sync shop**. Keep the page open until it completes. Resume a paused or interrupted sync with the same button.
6. In the report controls, select the historical date range you need.
7. Request the financial report, then check/import it when ready. Repeat with a daily overview report if wanted.
8. Review any reconciliation errors before retrying. Older CSV records are matched by ledger transaction ID.

**Done when:** your inventory/orders/shipments appear and the financial report is marked imported. For a large history, use monthly report ranges. The app accepts USD financial reports only; other currencies stop with a clear message.

Supply pin purchase costs, storage locations, and off-platform expenses yourself. Whatnot cannot infer those. Local inventory cost notes are planning data and do not automatically create another expense or override Whatnot's recorded cost of goods.

Financial and overview API reports do not refresh wallet or payout history. The current Seller API has no wallet/payout endpoint or payout report type. Any previously uploaded wallet CSVs appear under **Imported wallet reference**, with their source and record dates. Their subtotals can be partial or stale and do not verify bank deposits. To update that reference, upload a current wallet CSV for the period you want to review; use Whatnot's wallet/bank records to confirm actual payouts. A completed shop sync does not make historical wallet CSV statuses current.

## 6. Set up your 4 × 6 printer

1. In Whatnot Seller Hub, open **Shipments → Sidebar → Default Label Options**.
2. Set **Shipping label format** to **4 × 6 inches**.
3. Check the return address before generating a label.
4. Install your thermal printer so it appears in your computer's print dialog.
5. In Storybook Finds, open **Shipping** after the show has ended.
6. Review the shipment and confirm that bundling is finished.
7. Request a label. Wait for **Label ready**; queued does not mean generated.
8. Select ready shipments and click **Print selected**.
9. Choose your thermal printer, **4 × 6** paper, and **Actual size / 100%**.
10. Print one test label and check that its barcode and edges are clear.

Reprint opens the existing label; it does not generate new postage. Printing does not mark a shipment as handed to the carrier. Weight, dimensions, bundling changes, and label-format corrections open Whatnot Seller Hub because the current API does not expose those edits.

Print batches support up to 20 ready labels within a 4 MB output limit. Smaller batches help with slow document providers. Batch PDFs preserve the actual label pages; letter-size documents stop with a setup message rather than being squeezed onto thermal paper. Browser printing uses a print dialog, not an unattended printer connection.

## 7. Enable automatic daily updates

Complete this after manual sync works.

1. In Supabase, open **Project Settings → API keys → Legacy API keys**.
2. Copy the **service_role** JWT privately. This is a different key from the publishable key.
3. In Vercel, add `SUPABASE_SERVICE_ROLE_KEY` as a Production **Secret**.
4. Generate a random secret of at least 32 characters in your password manager.
5. Add it in Vercel as `CRON_SECRET`, also a Production **Secret**.
6. Redeploy.

The included Vercel schedule runs at **08:00 UTC daily**, compatible with a daily cron schedule. The worker is pinned to your configured workspace owner. It resumes bounded pages, checks report jobs, and commits finances with conflict protection. Large catalogs may need multiple runs; the manual Sync shop action can advance the same checkpoint faster. This is daily synchronization, not a guarantee of immediate order updates. More frequent schedules depend on your Vercel plan; check its current cron limits before changing the schedule.

If automatic sync is not configured, manual sync still works. Existing expense and CSV features work without any Whatnot token.

## 8. Optional webhook inbox

1. In the Whatnot developer dashboard, configure an app webhook subscription.
2. Use `https://YOUR-SHOP-DOMAIN/api/whatnot-worker/webhooks` as the delivery URL.
3. Select the order, shipment, product, and show topics your app has permission to receive.
4. Copy the webhook signing secret into Vercel as `WHATNOT_WEBHOOK_SECRET`, including its `wn_wh_` prefix.
5. Redeploy.

The webhook endpoint verifies the raw signature, time window, seller, and event ID, then saves a durable notification before acknowledging it. The daily worker reconciles authoritative API state; the inbox does not promise immediate UI changes. The app can refresh label documents directly while you are shipping.

## If something gets stuck

| Message | One next action |
| --- | --- |
| Token expired/revoked | Replace `WHATNOT_API_TOKEN` in Vercel and redeploy |
| Different seller/workspace | Check both account IDs; do not overwrite an existing connection to migrate shops |
| Seller storage needs setup | Run migration 003 |
| Customer documents unavailable | Check `read:customers` and Whatnot's customer-data approval |
| Label still generating | Refresh the shipment; queued worker failures are not exposed by Whatnot's API |
| Shipment needs attention | Open its Seller Hub link and correct the shipment there |
| Financial reconciliation conflict | Compare the original record/report; the importer preserves the existing amount |
| Financial data changed in another tab | Check/import the report again; it reloads the latest workspace |

Sources: [Authentication](https://developers.whatnot.com/getting-started/authentication), [Reports](https://developers.whatnot.com/reports), [Request label](https://developers.whatnot.com/whatnot-seller-api/tag/shipments/post/shipments/shipment_id/generate_label), [Label settings](https://help.whatnot.com/hc/en-us/articles/38685820508941-Update-your-default-shipping-label-settings-size-return-address), [Webhooks](https://developers.whatnot.com/getting-started/webhooks).
