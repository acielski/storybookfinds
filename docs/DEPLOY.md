# Publish Storybook Finds on Vercel

Work through one box at a time. Keep this page open beside Supabase and Vercel.

## 1. Set up the database

- [ ] In your Supabase project, open **SQL Editor** from the left menu. On a narrow screen, open the menu first.
- [ ] Click **New query**.
- [ ] Open [`supabase/migrations/001_workspace.sql`](../supabase/migrations/001_workspace.sql) in GitHub.
- [ ] Click **Raw**, then select all the SQL text and copy it.
- [ ] Paste it into the Supabase query editor.
- [ ] Click **Run**. You should see a success message with no returned rows.

It is safe to run this setup again. It creates one private workspace per account, with row-level security. Do not turn row-level security off.

## 2. Create your login

Your Supabase dashboard login is not automatically an app login. Create this account separately.

- [ ] In Supabase, open **Authentication → Users**.
- [ ] Click **Add user → Create new user**.
- [ ] Enter the email address you want to use for the app.
- [ ] Enter a strong password. Save it in your password manager.
- [ ] Enable **Auto Confirm User**, if shown, then create the user.
- [ ] Open **Authentication → Sign In / Providers** (sometimes labeled **Providers** or **Settings**).
- [ ] Find **Allow new users to sign up** under user signup settings. Turn it **off** and save. Keep the Email provider enabled.

The app has no public signup form. Each user account has its own separate data; creating a second user does not share the first user's workspace. For now, use the same shop account on your devices. To reset a forgotten password, use Supabase's admin user-management controls.

## 3. Find the two app settings

Keep these in a private note until you paste them into Vercel. You do not need to send anything in chat.

- [ ] Find your **Project URL** in Supabase **Project Settings → Data API**, or use the project URL displayed on your project overview. It looks like `https://YOUR_PROJECT_REF.supabase.co`.
- [ ] Open **Project Settings → API Keys**.
- [ ] Copy the **publishable key**. It normally starts with `sb_publishable_`. If your project only offers legacy keys, use the **anon** key.

**Do not use** the secret key, service-role key, or database password. This app only needs the publishable/anon key and the signed-in user's session.

## 4. Import the GitHub repo into Vercel

- [ ] Open https://vercel.com/new.
- [ ] Sign in with the GitHub account that owns `acielski/storybookfinds`.
- [ ] In **Import Git Repository**, find **storybookfinds**, then click **Import**. If it is missing, use **Adjust GitHub App Permissions** to grant Vercel access to that repository, then return.
- [ ] Leave **Root Directory** at the repository root (do not select `src`).
- [ ] Select **Vite** for Framework Preset if it was not detected.
- [ ] Leave Build Command as `npm run build` and Output Directory as `dist`.
- [ ] Under project settings, use **Node.js 24.x**. The repository also specifies this version.
- [ ] Expand **Environment Variables** and add the two rows below. Use your own project's values.

| Name — copy exactly | Value |
| --- | --- |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Your publishable key, or legacy anon key |

- [ ] Apply both variables to **Production**. Also add them to Preview if you want preview deployments to use this same database. Otherwise leave previews unconfigured; they will show a configuration error without exposing data.
- [ ] Click **Deploy**.
- [ ] Wait for **Ready**, then click **Visit**.

If you add or change an environment variable after deploying, use Vercel **Deployments → latest deployment → Redeploy**. Environment changes require a new deployment.

## 5. Check your published app

- [ ] Confirm you see the Storybook Finds sign-in screen.
- [ ] Sign in with the email and password created in **Step 2**.
- [ ] Add a small test expense. Refresh and confirm it remains.
- [ ] Delete that test expense.
- [ ] Sign out. Confirm the dashboard is hidden.
- [ ] Open a private/incognito browser window. Confirm it also requires sign-in.

## 6. Bring your records over

Your existing cloud-workspace SQLite data is preserved locally. It is not automatically uploaded to Supabase or included in GitHub.

- [ ] In the published app, use **Import CSV** and select your original Whatnot exports (up to 20 files at a time).
- [ ] The browser sends one file at a time to stay within Vercel's request limit. Wait for the results screen.
- [ ] Confirm the per-file added/skipped counts.
- [ ] Repeat an upload if you want to confirm duplicate checking: previously imported rows should be skipped.
- [ ] For manually entered records, export the Sales and Expenses CSVs from your original local app. Import them after the Whatnot reports. Existing matching Whatnot rows will be skipped, while new manual records will be added. Review any rows whose descriptions start with spreadsheet formula characters; export escapes these for safety.

Do not delete your local database or original CSVs until you have checked the published totals. Configure Supabase backups appropriate to your plan; GitHub does not back up your shop data.

## If something looks wrong

| What you see | What to do |
| --- | --- |
| Supabase is not configured | Check both variable names in Vercel, then redeploy. |
| Invalid login credentials | Use the app user from Authentication → Users, not your Supabase dashboard password. |
| Email not confirmed | Confirm the user in Supabase, or recreate the app user with Auto Confirm enabled. |
| Supabase could not save or load | Run the SQL setup in Step 1 and check that both settings belong to that same Supabase project. |
| Data changed in another tab | Refresh and retry. Repeated CSV rows are skipped. |
| No data after sign-in | New accounts start empty. Upload your original reports. Confirm you are using the expected email. |
| Request too large | Use files no larger than 2 MB each. Use the app's upload screen, which sends one file per request. |
| Wrong design after deployment | Confirm Vercel deployed the latest commit on `main`, then refresh the page. |

After setup, pushes to `main` will redeploy the app automatically when Vercel's GitHub integration is connected. Deploying new code does not erase Supabase records.
