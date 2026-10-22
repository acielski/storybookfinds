# Shared shop access and a separate test site

Use two Supabase projects and two Vercel projects. Keep this page open and complete one stage at a time.

| | Live shop | Test shop |
|---|---|---|
| Vercel project | Your existing project | `storybookfinds-dev` |
| Git branch | `main` | `dev` |
| Supabase project | Your existing Storybook Finds project | `storybookfinds-dev` |
| Data | Real sales and expenses | Test data only |
| Visible banner | None | DEVELOPMENT |

The `dev` branch contains the shared-access changes. They have not been merged into production. Your current production code and records remain unchanged.

## Stage 1 — create the development database

1. In Supabase, return to your organization/project list.
2. Click **New project**.
3. Name it **storybookfinds-dev**.
4. Generate and save a separate database password; choose your preferred region and create the project.
5. Wait until the project is Healthy.
6. In this **new test project**, run `supabase/migrations/001_workspace.sql`, then `002_shared_workspaces.sql`, in that order using SQL Editor.
7. Under **Authentication → Users → Add user → Create new user**, create a test login. Enable Auto Confirm if shown.
8. Turn off public signups in this new project too; keep Email sign-in enabled.
9. Copy this project's URL and publishable key for Stage 2. Do not use the live project's key or URL here.

Users are separate in each Supabase project. An existing production login is not automatically created in development. Project limits and billing depend on your Supabase account; if a project limit prevents creation, resolve it in Supabase before proceeding. Do not substitute the production database.

## Stage 2 — create the development website

1. Open https://vercel.com/new and import `acielski/storybookfinds` again.
2. Set **Project Name** to `storybookfinds-dev`.
3. Leave the root directory at `./`, framework **Vite**, and Node **24.x**.
4. Add the settings below to this **new Vercel project**. Apply them to Production and Preview here. "Production" inside this project means the primary test website, not your existing live shop.

| Variable | Value for the DEV Vercel project |
|---|---|
| `SUPABASE_URL` | The **new test** Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | The **new test** project's publishable key |
| `APP_ENV` | `development` |
| `PRODUCTION_SUPABASE_URL` | The **existing live** Supabase URL, used only as a guard against connecting development to it |

5. Create the Vercel project. Until the next step it may build `main`; do not enter test records yet.
6. In this Vercel project's settings, find **Environments → Production → Branch Tracking** and change the tracked branch to **dev**. In some Vercel interfaces this appears under **Settings → Git → Production Branch**.
7. Under Deployments, create/redeploy a deployment from **dev**. Confirm its source branch is `dev`; redeploying an older `main` deployment does not switch its branch.
8. Visit this new project. Confirm the **DEVELOPMENT** banner is visible before entering anything.
9. Sign in with the test user from Stage 1. Add a test expense, refresh, and confirm it persists.
10. Visit your original live shop and confirm that test expense is absent.

The guard deliberately shows a configuration error if the dev project uses the same Supabase URL as production. Fix the dev environment settings and redeploy. Never remove the guard to bypass that check.

Optional username sign-in uses `SHOP_USERNAME` and `SHOP_LOGIN_EMAIL` as before, but the dev email must belong to a test account in the test Supabase project.

## Stage 3 — connect a second test user to the same test shop

1. In the **test Supabase project**, create a second app user under Authentication → Users. Use its own email and password, with Auto Confirm enabled.
2. Open `supabase/admin/add_shop_member.sql` from the **dev** branch in GitHub; copy its Raw contents into a new SQL Editor query in the **test project**.
3. Replace `OWNER_APP_EMAIL` with the first test user's app login email.
4. Replace `NEW_USER_EMAIL` with the second test user's app login email.
5. Leave `requested_role` as `viewer` if the person should only see records. Set it to `editor` only if they should add, change or delete records too.
6. Run the query. It refuses to proceed if either user is missing or an existing membership needs review.
7. Sign into the test site as the owner and add a recognizable test expense.
8. Sign into a private/incognito browser window as the second user, using their email and password. Confirm both users see that same expense.
9. For a viewer, confirm the View only badge appears and entry/import/delete controls are hidden. For an editor, add an expense and refresh the owner window to confirm it is shared.

Existing owner data is kept in place. Member personal data, if any, is not merged or deleted; assigning membership changes which shop the app opens for that member. One account belongs to one shared shop at a time.

Membership management stays in Supabase for now. An administrator can edit the role or delete a membership in the `workspace_members` table. Membership changes are checked on each API request. Deleting a membership revokes access to the shared shop; the user's own private workspace remains available. Creating a login alone does not grant shared access.

## Stage 4 — promote only after testing

1. Verify the dev site, two-user access, import duplicate checks, and pin metrics.
2. In the **production Supabase project**, run only `002_shared_workspaces.sql` if `001` is already installed. This preserves existing owner records and retains compatibility with the current single-user app while you deploy.
3. Merge the reviewed **dev** code into **main**. The existing production Vercel project should still track `main` and use only production Supabase settings.
4. Wait for production to deploy, then confirm the owner's existing records are present.
5. Create the second production app login and run `add_shop_member.sql` in the **production** project using the production users' emails.
6. Verify both users can see the real shop records, with the intended role.

Do not promote a dev deployment containing development settings into the live Vercel project. Merge the code; let the live project build it with its own production configuration. Database changes must be reviewed and applied separately in each project. After applying migration 002, do not rerun 001 by itself; if reinstalling, run both in order.

## Preview deployments from your original live Vercel project

Earlier setup may have assigned the live Supabase settings to both Production and Preview. Remove the **Preview** scope from those live settings in the original Vercel project; keep its Production values unchanged. Use `storybookfinds-dev` for testing instead.

New code blocks a Vercel Preview deployment unless it is explicitly configured as development with a separate database. A preview of the `dev` branch created by the original live Vercel project may therefore show a configuration message; use the new dedicated dev project and its DEVELOPMENT banner.

## Day-to-day workflow

- Make and push changes to **dev**.
- Test at the **dev** website using test accounts and data.
- After testing, merge the approved changes into **main**.
- The live website deploys from **main** using the live database.

Do not import production customer data into the test site unless you deliberately choose to make a protected copy. No accounts, passwords or records are copied automatically.
