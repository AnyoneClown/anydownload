# Supabase cloud sync

AnyDownload uses Supabase Auth for Google sign-in and a PostgreSQL row per user for optional device sync. Local storage remains the offline working copy. The extension calls Supabase's Auth and Data APIs directly; no database password, server SDK, or separate application server is required.

## Shared project

Created on 2026-09-11 in **AnyoneClown's Org**, region **eu-central-1 (Frankfurt)**. Supabase quoted **$0/month** at creation.

- [AnyDownload dashboard](https://supabase.com/dashboard/project/ingepnogawhwgwakgpao)
- Project URL: `https://ingepnogawhwgwakgpao.supabase.co`
- Public publishable key: `sb_publishable_b4-FtAiz2t0qy4XnHHLVxQ_I_ZlTxRk`

The sync migration and `sync-callback` function are deployed. The extension still requires this public configuration on its Sync page and explicit sync consent.

**Google setup:** Google sign-in is enabled. The Google OAuth **Web application** client uses authorized redirect URI `https://ingepnogawhwgwakgpao.supabase.co/auth/v1/callback`. Its client ID and secret are configured in [Supabase's Google provider settings](https://supabase.com/dashboard/project/ingepnogawhwgwakgpao/auth/providers?provider=Google), and `https://ingepnogawhwgwakgpao.supabase.co/functions/v1/sync-callback**` is in the [allowed redirect URLs](https://supabase.com/dashboard/project/ingepnogawhwgwakgpao/auth/url-configuration). Keep the Google client secret in Supabase only.

On 2026-09-12, a real Google sign-in in Firefox passed: account selection and consent, callback nonce validation, PKCE code exchange, verified Google identity, refresh-token rotation, and authenticated Data API access. The test used the extension's OAuth parameters and a separate API verification script; it uploaded no local extension data and signed out its test session afterwards. A cancelled OAuth round trip also returned to the callback with its nonce intact. Full login through the extension's Sync UI on Firefox desktop and Android remains to be verified; the installed release used for this check did not yet include Sync.

Verified on the hosted project on 2026-09-11: rollback SQL tests, the live runtime/API smoke test below, Auth password sessions and refresh-token rotation, and the callback's public access, no-cache/no-referrer headers, and absence of reflected authorization parameters. Supabase security and performance advisors returned no findings. Disposable test users were signed out and deleted; their users, sessions, and sync rows were confirmed removed. The later Google OAuth verification is recorded above.

## Set up a project

1. Create a Supabase project. Run [`migrations/20260911000000_cloud_sync.sql`](migrations/20260911000000_cloud_sync.sql) in its SQL editor. The migration enables row-level security, grants authenticated users access only to their own row, bounds stored data, and enforces sequential revisions. Keep these policies and grants enabled. See [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).
2. Enable Google in **Authentication → Sign In / Providers**. Create a Google OAuth client of type **Web application**, configure its consent screen, and enter its client ID and secret in the Supabase provider settings. Google's authorized redirect URI is `https://PROJECT.supabase.co/auth/v1/callback`. These Google credentials belong in Supabase, never in the extension. Follow [Supabase's Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), including test users while the Google OAuth app is in testing mode.
3. Deploy the included public callback function from the repository root with the [Supabase CLI](https://supabase.com/docs/guides/functions/deploy):

   ```sh
   supabase login
   supabase functions deploy sync-callback --project-ref PROJECT
   ```

   [`config.toml`](config.toml) disables JWT verification for this callback because the browser reaches it before the extension has exchanged the sign-in code. The function returns static plain text, reads no parameters, and stores no credentials. Other functions keep their normal verification settings. See [per-function configuration](https://supabase.com/docs/guides/functions/function-configuration).
4. In **Authentication → URL Configuration**, add this allowed redirect URL, substituting the same project reference:

   ```text
   https://PROJECT.supabase.co/functions/v1/sync-callback**
   ```

   The suffix permits the random query parameter used to bind the callback to the initiating login. Keep the project hostname and callback path fixed; do not allow arbitrary hosts. Supabase preserves the query when appending its authorization code. The extension additionally checks the exact callback path, random state, and originating browser tab, then exchanges the code using PKCE. See [redirect URL matching](https://supabase.com/docs/guides/auth/redirect-urls) and [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow).
5. Open AnyDownload's **Sync** page on each device. Enter the same project URL (`https://PROJECT.supabase.co`) and **publishable key** (`sb_publishable_…`), available in the Supabase project's Connect dialog or API Keys settings. A legacy `anon` key is also accepted. A public key identifies the project; Google sign-in and RLS identify and isolate each user. Never enter `sb_secret_…`, a `service_role` key, a database password, or the Google client secret. See [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys).
6. Save the project, accept the displayed sync consent and Firefox permissions, then choose **Continue with Google**. Use the same Google account on every device. Complete sign-in in the tab that AnyDownload opens, within ten minutes. The browser tab callback supports Firefox desktop and Android without depending on `identity.launchWebAuthFlow`.

Deploy one shared Supabase project for all users. Individual users only need its public configuration and their own Google account. The extension does not hardcode a project; enter the shared project's public configuration on the Sync page.

## Synced data and limits

| Data | Behavior |
| --- | --- |
| Background-image preference, filename template, smart filters, grid/list layout | Sync |
| Website ignore rules | Sync origin, hashed media identifier, and rule timestamp |
| Completed-download ledger | Sync source origin, hashed media identifier, completion time, filename, and media type |
| Destination folders, save-dialog preference, downloaded files, active downloads, browser download IDs, history, galleries, trackers, statistics | Stay on each device |
| Private-window data | Remains session-only and is never included in cloud sync |

There are at most 5,000 ignore rules and 5,000 ledger records per account, with at most 500 of each per website. When a merge crosses a record limit, the newest records are retained. Each snapshot is limited to 4 MiB of serialized UTF-8 JSON; the database also applies a 4 MiB bound to PostgreSQL's JSON text representation. Data exceeding the byte limit causes sync to report an error while keeping the local copy.

Changes sync after a short delay, with a scheduled check every 15 minutes and a **Sync now** action. The background may be suspended by Firefox or the device; pending changes sync when it runs again. Sync combines independent record changes from both devices. When both devices change or delete the same record since their last sync, the syncing device's change wins. Whole filter settings are one record. A compare-and-swap revision check retries concurrent writes up to three times; a later sync handles continued contention. The local apply journal survives interrupted storage writes.

Signing out stops sync and removes the active session from this device; existing local and cloud data remain. To prevent accidentally uploading one account's local data into another, this installation remains bound to its first Google account and Supabase project after sign-out. Switching accounts or migrating projects in place is not supported in this version. Use a separate Firefox profile/installation for a different account.

Cloud data is protected by Supabase authentication and per-user RLS, not end-to-end encryption; the project owner can access the database. Google manages the sign-in, and Supabase retains the authentication profile and synced records. To remove a user's cloud data, the project administrator can delete that user in Supabase Authentication; the database row is removed through its foreign-key cascade. Sign out on devices first to stop further uploads. The callback emits no application logs or third-party resources; Supabase's own infrastructure may retain request metadata under the project's logging settings.

## Verification

The dependency-free model and runtime tests run with `npm test`. The model suite also verifies that malformed remote records fail without changing local state, private/device-only keys are excluded, merge deletions propagate, and count/UTF-8 byte limits hold.

For an opt-in live API check, create two disposable users in a development project and set `ANYDOWNLOAD_SUPABASE_URL`, `ANYDOWNLOAD_SUPABASE_PUBLIC_KEY`, `ANYDOWNLOAD_TEST_TOKEN_A`, and `ANYDOWNLOAD_TEST_TOKEN_B` (fresh user access tokens, each with at least five minutes remaining). Run `node tests/cloud-sync-live-tests.cjs`. It refuses accounts with existing sync rows, then uses the actual extension runtime with memory storage to check uploads, pulls, offline merges, deletions, privacy, RLS, stale revisions, and payload validation through the hosted APIs. Delete both disposable users afterwards, including after a failed test, to remove their synthetic rows. This does not test Google sign-in or Firefox's browser lifecycle.

Run [`tests/sync.sql`](tests/sync.sql) as the database owner in a **development** project's SQL editor after applying the migration, or use:

```sh
psql "$ANYDOWNLOAD_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sync.sql
```

This creates two temporary auth users inside a rolled-back transaction and checks account isolation, anonymous access rejection, stale-write rejection, owner/timestamp protection, and payload limits. It requires database-owner access and does not need real user credentials. It has also been run against a disposable PostgreSQL 16 instance with Supabase's roles and `auth.uid()` behavior emulated.

Before publishing, run a live check with the configured project: sign in on Firefox desktop and Android, change settings on each, sync an ignore/ledger addition and deletion, verify offline edits reconcile, sign out, and confirm private-window activity never changes the cloud row. An unconfigured checkout cannot verify Google's redirects, the project's RLS deployment, or Android's actual browser lifecycle end to end.
