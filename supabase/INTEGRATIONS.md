# Immich integration setup

## Maintainer: enable encrypted connections

The integration migration and `external-integrations` Edge Function are **deployed** to the shared project as of 2026-09-12. AnyDownload 1.16.0 can use them without another extension update; reopen Integrations if it previously reported that connections could not load. Existing Google sign-in is reused; no Google Drive access is requested or granted. The steps below apply when deploying another project.

1. Apply [`20260912090936_external_integrations.sql`](migrations/20260912090936_external_integrations.sql) to a development Supabase project after the cloud-sync migration. Supabase Vault must be available; the migration enables it. Run [`tests/integrations.sql`](tests/integrations.sql) as the database owner before applying the migration to the intended project.
2. Deploy the endpoint using the repository's [`config.toml`](config.toml):

   ```sh
   supabase functions deploy external-integrations --project-ref PROJECT
   ```

3. Keep `anydownload_private` and `vault` outside Data API's exposed schemas. Keep the migration's grants, RLS, and function privileges intact. No client receives direct Vault access. Check Supabase's security/performance advisors after deployment.
4. Test with two disposable accounts: account A saves a connection; B cannot list, retrieve, replace, change its default album, or delete it. Check no-store headers on success and error responses, then verify that disconnecting A removes both its metadata and Vault secret. Do not put real keys into SQL snippets, shell commands, test logs, or support reports.

The function uses the built-in `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment values. It verifies the bearer token with Auth's `/auth/v1/user` endpoint, then forwards that same user token to an authenticated RPC. The RPC derives ownership from `auth.uid()` on every action. It accepts no client user ID and uses no service-role key. Disabling the gateway JWT check lets the handler return no-store headers on authentication errors; the handler still requires verified authentication. See [Supabase Auth integration](https://supabase.com/docs/guides/functions/auth-legacy-jwt) and [Edge Function authentication headers](https://supabase.com/docs/guides/functions/auth-headers).

Connection metadata is in `public.anydownload_connections`: owner, ID, provider, server origin, and optional default album. Encrypted credentials are in [Supabase Vault](https://supabase.com/docs/guides/database/vault), linked by an inaccessible private table. Connection lists contain no secrets. The narrow credential operation returns only that owner's key over the project's HTTPS API with `Cache-Control: no-store`; the RPC also sets [PostgREST response headers](https://postgrest.org/en/stable/references/transactions.html#response-headers). Keys are kept out of general cloud-sync payloads. Vault provides server-side encryption, not end-to-end encryption: the Supabase project administrator can access secrets.

Replacing a key keeps the connection's server origin fixed. Add a new connection for another server. Disconnecting removes the saved configuration and encrypted key; it does not delete Immich assets or revoke the original Immich API key. Revoke that key in Immich if you no longer need it. Deleting the AnyDownload account also cascades secret deletion. There are at most 20 connections per account.

## User: connect Firefox to Immich

This implementation targets **Immich v3.2.0**. Create an API key in Immich's account settings with `asset.upload` for library uploads. Selecting an album additionally needs `album.read`, `albumAsset.create`, and `user.read`; the account must own the album or have the editor role. Avoid granting unrelated permissions. Endpoint schemas and permissions were checked against the [v3.2.0 API specification](https://github.com/immich-app/immich/blob/v3.2.0/open-api/immich-openapi-specs.json) and [release](https://github.com/immich-app/immich/releases/tag/v3.2.0).

1. Sign in to your AnyDownload account through **Sync**. Open **Integrations**, select **Immich**, and enter the server address and API key in the masked field.
2. Use the server's base address, for example `http://192.168.0.103:2283` or `https://immich.example-tailnet.ts.net`. Pasting the known `/albums` UI page normalizes to that base. Custom API subpaths, credentials in URLs, and redirecting API endpoints are unsupported; enter the final server origin.
3. Choose **Test & save connection** and accept Firefox's permission for that server. Uploads also request access to their source-media hosts through an explicit user action. Firefox on the device performs the key test, album requests, source downloads, and uploads. Supabase never tries to connect to your LAN/Tailscale server and never proxies image bytes.
4. In the media manager choose **Upload selected**, select the connection, then choose the library or an existing writable album. The default album belongs to that connection. The upload page also accepts image files selected from the device, including files already downloaded locally.

For remote use, the device running Firefox must already have network access to the Immich server. Connect Tailscale on both ends, or use a configured subnet route for a LAN address. [MagicDNS](https://tailscale.com/docs/features/magicdns) names resolve devices in your tailnet; they do not automatically grant access through its access rules or a firewall. If the test fails, check the address/port, server availability, Firefox permission, certificate, DNS, and Tailscale connection or subnet routing. A failed network request alone cannot identify which of these failed. See [Immich remote access](https://docs.immich.app/guides/remote-access/).

Keep the visible upload-progress tab open. Images are processed sequentially within the existing image-size bound. Asset upload and album attachment have separate results: an existing duplicate asset may still need album attachment; a failed attachment can retry using the saved asset ID. Closing the tab/browser interrupts work; reopening reports unfinished work and requires explicit retry. There is no background or byte-resume promise. Remote results are independent of the local-download ledger, and integrations are unavailable in private windows.

Each upload accepts at most 500 images, 64 MiB per image, and 2 MB of source URLs. Device history holds at most 20 jobs and 4 MiB of metadata; remove an old record when it fills. Local file bytes are never saved: reselect the original files after reopening an unfinished local-file job. Embedded `data:` images must first be saved locally. Source redirects are rejected, so recollect the final original-image URL if necessary. Authenticated Immich requests also reject redirects. An unconfirmed asset upload is retried in full, with Immich's duplicate detection handling bytes it may already have received.

The key test calls authenticated `GET /api/api-keys/me`, which returns the key's permissions; an unauthenticated ping does not validate a key. Image uploads use `POST /api/assets` multipart fields `assetData`, `fileCreatedAt`, and `fileModifiedAt`; v3.2.0 returns an asset ID and `created`/`duplicate` status. Album mode identifies the user with `GET /api/users/me`, lists albums with `GET /api/albums`, and attaches the returned asset ID with `PUT /api/albums/{id}/assets` and `{ids: [assetId]}`. The per-asset response confirms attachment, including an already-attached duplicate. See [key details](https://api.immich.app/endpoints/api-keys/getMyApiKey), [asset upload](https://api.immich.app/endpoints/assets/uploadAsset), [album listing](https://api.immich.app/endpoints/albums/getAllAlbums), and [album attachment](https://api.immich.app/endpoints/albums/addAssetsToAlbum).

## Backend API

All calls are `POST /functions/v1/external-integrations` with the signed-in bearer token, public project key, and JSON body. Neither keys nor parameters belong in URLs.

| Action | Additional body fields | Success response |
| --- | --- | --- |
| `list` | none | `{connections: [...]}` |
| `save` | `provider: "immich"`, `serverUrl`, `apiKey`; optional `connectionId`, `defaultAlbumId` | `{connection: ...}` |
| `credential` | `connectionId` | `{connection: ..., apiKey: ...}` |
| `defaultAlbum` | `connectionId`, `defaultAlbumId` (UUID or null) | `{connection: ...}` |
| `delete` | `connectionId` | `{deleted: true}` |

Metadata has `id`, `provider`, `serverUrl`, and `defaultAlbumId`. Save without an ID creates a connection; save with an ID replaces its key for the same server. Save resets the default album to null when it is omitted. Only `credential` returns a key. Errors are static `{error: ...}` responses and do not reflect submitted data or database error details.

## Verification status

`npm test` includes the provider, upload runner, progress page, credential client, cloud runtime, and backend handler checks. Node 22.13+ is required for the backend test's built-in TypeScript stripping; no dependency is added. `node tests/integration-backend-tests.cjs` runs the actual handler with mocked Auth/Data APIs and checks authentication, bounds, metadata redaction, HTTP methods, and safe no-store errors. `deno check supabase/functions/external-integrations/index.ts` typechecks the Edge Function.

On 2026-09-12 the migration and rollback SQL tests passed in disposable PostgreSQL 16 with Supabase Auth roles and the Vault API **emulated using pgcrypto**. This validates SQL syntax, RLS/ownership checks, replacement, origin binding, and cleanup; it does **not** verify the hosted Vault extension or deployed Edge Function. The rollback left zero synthetic users or secrets. No live Immich upload or Tailscale connection was exercised during these backend checks.

Later that day the migration and Edge Function version 1 were deployed to the shared project with real Vault 0.3.1. The migration revokes access to Vault's public secret API explicitly because hosted `postgres` cannot change Supabase-owned internal crypto-function grants. Hosted read-only checks confirmed that neither `anon` nor `authenticated` has Vault schema, table, or routine access, private secret references remain inaccessible, and connection metadata has forced RLS with read-only client access. Missing and invalid sessions both return HTTP 401 with `Cache-Control: no-store` from the live endpoint. The full local test suite passed. Authenticated save/retrieve and actual Immich uploads remain unverified: automatic approval review blocked synthetic-user/Vault mutation tests on the shared project, and Firefox UI inspection timed out.

The performance advisor returned no findings. The security advisor reports [RLS with no policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) on the private secret-reference table, which intentionally denies direct client access, and an unrelated [disabled leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) warning. The extension uses Google sign-in; no Auth settings were changed.

For an opt-in end-to-end backend check, `node tests/integrations-live-tests.cjs` accepts fresh disposable user tokens through `ANYDOWNLOAD_TEST_TOKEN_A` and `ANYDOWNLOAD_TEST_TOKEN_B`. It refuses accounts with existing connections, uses synthetic keys and non-routable `.invalid` origins, checks both directions of account isolation and no-store responses, and deletes its own connection IDs in `finally`. It contacts only the bundled Supabase project. Obtain approval before creating disposable accounts in the shared project, and delete those accounts after testing. This check has not yet been run against the hosted backend.

Run the real Vault test in a development Supabase project after applying the migration:

```sh
psql "$ANYDOWNLOAD_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/integrations.sql
```

Before release, verify an actual upload without an album, an upload to an owned/editor album, a duplicate, an attachment-only retry, cancellation/interruption, and LAN/Tailscale connectivity on Firefox desktop and Android. Automated responses cannot prove those live behaviors.
