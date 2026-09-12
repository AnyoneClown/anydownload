"use strict";

// Opt-in: use two disposable authenticated users in the bundled shared project.
// ANYDOWNLOAD_TEST_TOKEN_A / ANYDOWNLOAD_TEST_TOKEN_B are fresh user access tokens.
// Run: node tests/cloud-sync-live-tests.cjs
// Delete the disposable users afterwards; their synthetic sync rows cascade away.
const assert = require("node:assert/strict");
const Runtime = require("../extension/shared/cloud-sync-runtime.js");
const Model = require("../extension/shared/cloud-sync.js");
const Core = require("../extension/shared/core.js");
const Ledger = require("../extension/shared/download-ledger.js");

async function main() {
  const required = ["ANYDOWNLOAD_TEST_TOKEN_A", "ANYDOWNLOAD_TEST_TOKEN_B"];
  for (const name of required) assert.ok(process.env[name], `Set ${name}; use disposable development users only.`);
  const config = Runtime.CONFIG;
  const tokens = required.map((name) => process.env[name]);
  const expirations = tokens.map((token) => {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    assert.equal(claims.role, "authenticated", "Use user access tokens, never privileged credentials.");
    assert.ok(claims.exp * 1000 > Date.now() + 300000, "Provide fresh tokens with at least five minutes left.");
    return claims.exp * 1000;
  });
  let requests = 0;
  async function fetcher(url, options = {}) {
    requests += 1;
    return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
  }
  async function api(path, token, { method = "GET", body, status = 200 } = {}) {
    const response = await fetcher(`${config.url}${path}`, {
      method, redirect: "error", credentials: "omit",
      headers: {
        apikey: config.publicKey, "Content-Type": "application/json", Prefer: "return=representation",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    assert.equal(response.status, status, `${method} ${path} returned unexpected HTTP status`);
    return response.json();
  }
  const users = await Promise.all(tokens.map((token) => api("/auth/v1/user", token)));
  for (const user of users) assert.match(user.id, /^[0-9a-f-]{36}$/i);
  assert.notEqual(users[0].id, users[1].id, "Use two different disposable accounts.");
  const table = "/rest/v1/anydownload_sync";
  const rowPath = (index) => `${table}?user_id=eq.${users[index].id}`;
  for (const token of tokens) {
    assert.deepEqual(await api(`${table}?select=user_id&limit=2`, token), [], "Refusing to modify an account with existing sync data.");
  }
  console.log("Verified two empty development accounts; testing synthetic sync data.");

  function device(index, initial = {}) {
    const data = {
      ...structuredClone(initial), destinationFolder: "device-only", askForSingle: true,
      [Runtime.STATE_KEY]: {
        config, consent: true, owner: { userId: users[index].id, project: config.url }, base: {}, lastSync: Date.now(),
        session: { userId: users[index].id, accessToken: tokens[index], expiresAt: expirations[index] }
      }
    };
    const ignoredPrivate = `ignoredImage:${encodeURIComponent("https://private.example.test")}:${Core.ignoreKeyForUrl("https://private.example.test/private.jpg")}`;
    const temporary = { includeBackgrounds: false, [ignoredPrivate]: 123 };
    const event = () => ({ addListener() {} });
    function storage(values) {
      return {
        async get(key) { return structuredClone(key === null ? values : { [key]: values[key] }); },
        async set(next) { Object.assign(values, structuredClone(next)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
      };
    }
    let message;
    const browser = {
      runtime: {
        id: "anydownload-live-test", getURL: (path) => `moz-extension://anydownload-live-test/${path.replace(/^\//, "")}`,
        onMessage: { addListener(listener) { message = listener; } }
      },
      storage: { local: storage(data), session: storage(temporary), onChanged: event() },
      permissions: { contains: async () => true, getAll: async () => ({ data_collection: Runtime.DATA_TYPES }), onRemoved: event() },
      alarms: { create() {}, onAlarm: event() },
      tabs: { onUpdated: event(), onRemoved: event() }
    };
    const runtime = Runtime.start(browser, { fetch: fetcher });
    return {
      data, temporary, ready: runtime.ready,
      async sync(incognito = false) {
        const result = await message({ type: "CLOUD_SYNC", action: "sync" }, {
          id: browser.runtime.id, url: browser.runtime.getURL("sync/sync.html"), tab: { incognito }
        });
        assert.equal(result.ok, !incognito, result.error || "Unexpected sync result");
      }
    };
  }

  const site = "https://example.test";
  const ignore = `ignoredImage:${encodeURIComponent(site)}:${Core.ignoreKeyForUrl(`${site}/live.jpg`)}`;
  const entry = { siteKey: site, fingerprint: Ledger.mediaFingerprint({ url: `${site}/live.jpg` }), completedAt: 123, filename: "live.jpg", mediaType: "image" };
  const original = Model.normalizeSnapshot({ includeBackgrounds: true, mediaLayout: "grid", [ignore]: 123, [`ledger:${encodeURIComponent(site)}:${entry.fingerprint}`]: entry });
  const first = device(0, Model.toStorage(original));
  const second = device(0);
  const other = device(1, { mediaLayout: "list" });
  await Promise.all([first.ready, second.ready, other.ready]);
  await first.sync();
  assert.deepEqual((await api(`${rowPath(0)}&select=revision,payload`, tokens[0]))[0], { revision: 1, payload: original });
  await second.sync();
  assert.deepEqual(Model.snapshot(second.data), original, "Second device must pull the first upload.");

  first.data.mediaLayout = "list";
  second.data.includeBackgrounds = false;
  await first.sync();
  await second.sync();
  await first.sync();
  assert.equal(first.data.includeBackgrounds, false, "Offline changes on independent records must merge.");
  assert.equal(second.data.mediaLayout, "list");
  delete second.data[ignore];
  second.data[Ledger.STORAGE_KEY] = Ledger.emptyState();
  await second.sync();
  await first.sync();
  assert.equal(Object.hasOwn(first.data, ignore), false, "Ignore deletion must propagate.");
  assert.deepEqual(first.data[Ledger.STORAGE_KEY].entries, [], "Ledger deletion must propagate.");
  assert.equal(first.data.destinationFolder, "device-only");
  const beforePrivate = requests;
  await first.sync(true);
  assert.equal(requests, beforePrivate, "Private windows must make no cloud requests.");
  assert.equal(first.temporary.includeBackgrounds, false);
  const [row] = await api(`${rowPath(0)}&select=revision,payload`, tokens[0]);
  assert.deepEqual(row.payload, { includeBackgrounds: false, mediaLayout: "list" }, "Upload must exclude device and private data.");

  assert.deepEqual(await api(`${rowPath(0)}&select=payload`, tokens[1]), [], "Another account must not read this payload.");
  assert.deepEqual(await api(rowPath(0), tokens[1], { method: "PATCH", body: { revision: row.revision + 1, payload: {} } }), [], "Another account must not update this payload.");
  await api(table, tokens[0], { method: "POST", body: { user_id: users[1].id, revision: 1, payload: {} }, status: 403 });
  await other.sync();
  assert.deepEqual(await api(`${rowPath(1)}&select=payload`, tokens[0]), []);
  assert.deepEqual(await api(`${rowPath(0)}&revision=eq.${row.revision - 1}`, tokens[0], { method: "PATCH", body: { revision: row.revision + 1, payload: {} } }), [], "Stale revision must not overwrite current data.");
  await api(rowPath(0), tokens[0], { method: "PATCH", body: { revision: row.revision + 2, payload: {} }, status: 400 });
  await api(rowPath(0), tokens[0], { method: "PATCH", body: { revision: row.revision + 1, payload: { accessToken: "invalid-field" } }, status: 400 });
  await api(`${table}?select=revision&limit=1`, null, { status: 401 });
  assert.equal(await api("/rest/v1/rpc/anydownload_valid_sync_payload", tokens[0], { method: "POST", body: { data: { mediaLayout: "grid" } } }), true);
  assert.equal(await api("/rest/v1/rpc/anydownload_valid_sync_payload", tokens[0], { method: "POST", body: { data: { accessToken: "invalid-field" } } }), false);
  assert.deepEqual((await api(`${rowPath(0)}&select=revision,payload`, tokens[0]))[0], row, "Rejected writes must leave the original row intact.");
  console.log("Live cloud sync passed: upload/pull, offline merge, deletions, privacy, RLS, CAS, payload validation, and RPC.");
  console.log("Delete both disposable auth users to remove the test rows.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
