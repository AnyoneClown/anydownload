"use strict";

const assert = require("node:assert/strict");
const { webcrypto, createHash } = require("node:crypto");
const Runtime = require("../extension/shared/cloud-sync-runtime.js");
const Model = require("../extension/shared/cloud-sync.js");
const Core = require("../extension/shared/core.js");

const PROJECT = "https://ingepnogawhwgwakgpao.supabase.co";
const CONFIG = { url: PROJECT, publicKey: "sb_publishable_b4-FtAiz2t0qy4XnHHLVxQ_I_ZlTxRk" };
const OTHER_PROJECT = "https://otherproject.supabase.co";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const STATE = "cloudSync:v1";
const LOGIN = "cloudLogin:v1";
const EXTENSION = "moz-extension://anydownload-test";
const SITE = "https://example.test";
const IGNORE = `ignoredImage:${encodeURIComponent(SITE)}:${Core.ignoreKeyForUrl(`${SITE}/a.jpg`)}`;
const PRIVATE_IGNORE = `ignoredImage:${encodeURIComponent(SITE)}:${Core.ignoreKeyForUrl(`${SITE}/private.jpg`)}`;
const clone = (value) => structuredClone(value);
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

function signedState(overrides = {}) {
  return {
    config: CONFIG, consent: true, owner: { userId: USER, project: PROJECT },
    session: { userId: USER, email: "user@example.test", accessToken: "access-old", refreshToken: "refresh-old", expiresAt: Date.now() + 3600000 },
    base: {}, lastSync: Date.now(), ...overrides
  };
}

function token(userId = USER) {
  return { user: { id: userId, email: "user@example.test" }, access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 };
}

function event() {
  const listeners = [];
  return { addListener: (listener) => listeners.push(listener), emit: (...args) => Promise.all(listeners.map((listener) => listener(...args))) };
}

function harness({ stored = {}, session = {}, fetch: handler } = {}) {
  const local = clone(stored);
  const temporary = clone(session);
  const calls = [];
  const notifications = [];
  const tabs = new Map();
  const alarms = [];
  const clearedAlarms = [];
  const hooks = {};
  const permissions = { origins: true, data: [...Runtime.DATA_TYPES] };
  const changed = event();
  function storage(data, area) {
    return {
      async get(keys) {
        const names = keys === null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return clone(Object.fromEntries(names.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])));
      },
      async set(values) {
        if (area === "local" && hooks.set) await hooks.set(values);
        const changes = Object.fromEntries(Object.keys(values).map((key) => [key, { oldValue: clone(data[key]), newValue: clone(values[key]) }]));
        Object.assign(data, clone(values));
        await changed.emit(changes, area);
      },
      async remove(keys) {
        keys = Array.isArray(keys) ? keys : [keys];
        if (area === "local" && hooks.remove) await hooks.remove(keys);
        const changes = Object.fromEntries(keys.map((key) => [key, { oldValue: clone(data[key]) }]));
        for (const key of keys) delete data[key];
        await changed.emit(changes, area);
      }
    };
  }
  const browser = {
    runtime: { id: "anydownload@test", getURL: (path) => `${EXTENSION}/${path.replace(/^\//, "")}`, onMessage: event(),
      async sendMessage(message) { notifications.push(clone(message)); } },
    storage: { local: storage(local, "local"), session: storage(temporary, "session"), onChanged: changed },
    permissions: {
      contains: async () => permissions.origins,
      getAll: async () => permissions.data === undefined ? {} : { data_collection: [...permissions.data] },
      onRemoved: event()
    },
    alarms: { create: (name, info) => alarms.push({ name, ...info }), clear: async name => { clearedAlarms.push(name); return true; }, onAlarm: event() },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async create(info) { const tab = { id: tabs.size + 1, incognito: false, ...info }; tabs.set(tab.id, tab); return clone(tab); },
      async update(id, info) { Object.assign(tabs.get(id), info); return clone(tabs.get(id)); },
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return clone(tabs.get(id)); },
      async remove(id) { tabs.delete(id); }
    }
  };
  const sender = (path = "sync/sync.html", extra = {}) => ({ id: browser.runtime.id, url: browser.runtime.getURL(path), ...extra });
  let lock = Promise.resolve();
  const runtime = Runtime.start(browser, {
    crypto: webcrypto,
    withStorageLock(callback) { const work = lock.catch(() => undefined).then(callback); lock = work; return work; },
    async fetch(url, options) {
      assert.equal(new URL(url).origin, PROJECT, "Every runtime request must use the shipped project");
      assert.equal(options.headers.apikey, CONFIG.publicKey, "Every runtime request must use the shipped public key");
      const call = { url, ...options, body: options.body === undefined ? undefined : JSON.parse(options.body) };
      calls.push(call);
      if (handler) return handler(call, { local, temporary, browser, calls });
      if (url.includes("/auth/v1/token")) return response(token());
      if (url.endsWith("/auth/v1/user")) return response({ id: USER });
      if (url.includes("/rest/")) return response(options.method === "GET" ? [] : [{ revision: call.body.revision, payload: call.body.payload }]);
      return response({});
    }
  });
  return {
    browser, local, temporary, calls, notifications, tabs, alarms, clearedAlarms, hooks, permissions, sender, runtime,
    async message(action, values = {}, from = sender()) { return (await browser.runtime.onMessage.emit({ type: "CLOUD_SYNC", action, ...values }, from))[0]; },
    async write(values, from = sender("popup/popup.html")) { return (await browser.runtime.onMessage.emit({ type: "CLOUD_LOCAL_WRITE", action: "set", values }, from))[0]; },
    async callback(url, id = temporary[LOGIN].tabId, tab = { id, incognito: false }) { await browser.tabs.onUpdated.emit(id, { url }, tab); }
  };
}

async function beginLogin(h) {
  await h.runtime.ready;
  assert.equal((await h.message("signin", { consent: true })).ok, true);
  return clone(h.temporary[LOGIN]);
}

function callbackUrl(login) {
  return `${login.project}/functions/v1/sync-callback?state=${login.nonce}&code=one-time-code`;
}

async function consentAndTrust() {
  const h = harness();
  await h.runtime.ready;
  assert.deepEqual(Runtime.CONFIG, CONFIG);
  assert.equal(Object.isFrozen(Runtime.CONFIG), true);
  const status = await h.message("status");
  assert.equal(status.configured, true);
  assert.deepEqual(status.config, CONFIG);
  assert.equal(status.consent, false);
  await h.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
  assert.equal((await h.message("signin")).ok, false);
  assert.equal((await h.message("configure", { consent: true, config: CONFIG })).ok, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.tabs.size, 0);
  for (const sender of [h.sender("sync/sync.html", { id: "other@extension" }), h.sender("sync/sync.html", { url: "https://evil.test/sync/sync.html" }), h.sender("popup/popup.html"), h.sender("sync/sync.html", { tab: { incognito: true } })]) {
    assert.equal((await h.message("signin", { consent: true }, sender)).ok, false);
  }
  assert.equal((await h.write({ includeBackgrounds: true }, h.sender("popup/popup.html", { tab: { incognito: true } }))).ok, false);
  assert.equal((await h.write({ "cloudSync:v1": signedState() })).ok, false);
  h.permissions.origins = false;
  assert.equal((await h.message("signin", { consent: true })).ok, false);
  h.permissions.origins = true;
  h.permissions.data = [];
  assert.equal((await h.message("signin", { consent: true })).ok, false);
  assert.equal((await h.message("status")).consent, false, "Denied permissions cannot enable sync");
  assert.equal(h.tabs.size, 0);
  h.permissions.data = undefined; // Firefox versions before data_collection permission support.
  assert.equal((await h.message("signin", {
    consent: true, config: { url: OTHER_PROJECT, publicKey: "sb_publishable_ignored_override" }
  })).ok, true);
  const login = clone(h.temporary[LOGIN]);
  assert.equal(new URL(h.tabs.get(login.tabId).url).origin, PROJECT, "Message configuration cannot redirect Google sign-in");
  assert.deepEqual(h.local[STATE].config, CONFIG);
  assert.equal((await h.message("sync")).ok, false);
  assert.equal(h.calls.length, 0, "No account data is requested or uploaded before sign-in completes");
  assert.equal(h.local.includeBackgrounds, undefined);
  await h.callback(callbackUrl(login));
  assert.equal(h.local[STATE].session.userId, USER);
  assert.equal((await h.message("signout")).ok, true);
  assert.equal((await h.message("signin")).ok, false, "Stored consent does not bypass consent on a new sign-in request");

  const noConsent = harness({ stored: { [STATE]: signedState({ consent: false, lastSync: 0 }) } });
  await noConsent.runtime.ready;
  await noConsent.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
  assert.equal(noConsent.calls.length, 0, "A stored session never overrides withdrawn consent");
}

async function sharedProjectMigration() {
  const base = { includeBackgrounds: true, mediaLayout: "list" };
  const saved = signedState({
    config: { url: PROJECT, publicKey: "sb_publishable_previous_public_key" }, base, revision: 7
  });
  const existing = harness({ stored: { ...base, [STATE]: saved }, fetch: () => response([{ revision: 7 }]) });
  await existing.runtime.ready;
  assert.deepEqual(existing.local[STATE], { ...saved, config: CONFIG }, "Shared-project upgrades retain session, account binding and sync history");
  assert.equal(existing.calls.length, 0);
  assert.equal((await existing.message("sync")).ok, true);
  assert.equal(existing.calls.length, 1);

  const target = { mediaLayout: "list" };
  for (const mismatch of ["config", "owner", "journal"]) {
    const old = signedState({
      config: { url: mismatch === "owner" ? PROJECT : OTHER_PROJECT, publicKey: "sb_publishable_previous_public_key" },
      owner: { userId: USER, project: mismatch === "config" ? PROJECT : OTHER_PROJECT }, base, revision: 9, lastSync: 0,
      ...(mismatch === "journal" ? { journal: { target, remote: target } } : {})
    });
    const pending = { tabId: 23, project: OTHER_PROJECT, nonce: "old-nonce", verifier: "old-verifier", expiresAt: Date.now() + 60000 };
    const h = harness({
      stored: { ...base, destinationFolder: "device/path", [STATE]: old },
      session: { [LOGIN]: pending, [PRIVATE_IGNORE]: 100 }
    });
    h.tabs.set(pending.tabId, { id: pending.tabId, url: callbackUrl(pending), incognito: false });
    await h.runtime.ready;
    const migrated = h.local[STATE];
    assert.deepEqual(migrated.config, CONFIG);
    assert.equal(migrated.consent, false);
    assert.equal(Boolean(migrated.session), false);
    assert.equal(Boolean(migrated.owner), false);
    assert.deepEqual(migrated.base || {}, {});
    assert.equal(migrated.revision || 0, 0);
    assert.equal(Boolean(migrated.journal), false);
    assert.ok(migrated.error, "Changing the cloud destination requires an explanatory notice");
    assert.deepEqual(Model.snapshot(h.local), mismatch === "journal" ? target : base, "Migration retains local data and completes interrupted writes");
    assert.equal(h.local.destinationFolder, "device/path");
    assert.equal(h.temporary[PRIVATE_IGNORE], 100);
    assert.equal(h.temporary[LOGIN], undefined, "A login started for the old project cannot resume after migration");
    await h.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
    assert.equal((await h.message("signin")).ok, false);
    assert.equal(h.calls.length, 0, "Migration never sends the old session or local data to either project");
    assert.equal((await h.message("signin", { consent: true })).ok, true);
    assert.equal(h.temporary[LOGIN].project, PROJECT);
  }
}

async function authentication() {
  const h = harness();
  const login = await beginLogin(h);
  const authorization = new URL(h.tabs.get(login.tabId).url);
  assert.equal(authorization.origin, PROJECT);
  assert.equal(authorization.pathname, "/auth/v1/authorize");
  assert.equal(authorization.searchParams.get("provider"), "google");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "s256");
  assert.equal(authorization.searchParams.get("code_challenge"), createHash("sha256").update(login.verifier).digest("base64url"));
  assert.equal(authorization.href.includes(login.verifier), false, "Only the hash may leave in the authorization URL");
  const callback = new URL(authorization.searchParams.get("redirect_to"));
  assert.equal(callback.origin, PROJECT);
  assert.equal(callback.searchParams.get("state"), login.nonce);
  assert.equal(h.calls.length, 0);
  for (const [url, id, tab] of [
    [callbackUrl(login), login.tabId + 1, { incognito: false }],
    [callbackUrl(login), login.tabId, { incognito: true }],
    [callbackUrl(login).replace(PROJECT, "https://evil.test"), login.tabId],
    [callbackUrl(login).replace("sync-callback?", "sync-callback/extra?"), login.tabId],
    [callbackUrl(login).replace(login.nonce, "wrong-state"), login.tabId]
  ]) await h.callback(url, id, tab);
  assert.equal(h.calls.length, 0, "Wrong tab, private tab, origin, path, or state cannot exchange a code");
  await h.callback(callbackUrl(login));
  assert.equal(h.local[STATE].session.userId, USER);
  assert.equal(h.temporary[LOGIN], undefined);
  assert.equal(h.tabs.get(login.tabId).url, `${EXTENSION}/sync/sync.html`);
  assert.deepEqual(h.calls[0].body, { auth_code: "one-time-code", code_verifier: login.verifier });
  assert.equal(h.calls[1].url, `${PROJECT}/auth/v1/user`);
  assert.equal(h.calls[1].headers.Authorization, "Bearer access-new");
  const count = h.calls.length;
  await h.callback(callbackUrl(login), login.tabId);
  assert.equal(h.calls.length, count, "A consumed callback cannot replay the token exchange");

  for (const failure of ["project", "expired", "user", "owner"]) {
    const broken = harness({ fetch: (call) => call.url.endsWith("/user") ? response({ id: failure === "user" ? OTHER_USER : USER }) : response(token()) });
    const flow = await beginLogin(broken);
    if (failure === "project") broken.local[STATE].config.url = "https://changedproject.supabase.co";
    if (failure === "expired") broken.temporary[LOGIN].expiresAt = Date.now() - 1;
    if (failure === "owner") broken.local[STATE].owner = { userId: OTHER_USER, project: PROJECT };
    await broken.callback(callbackUrl(flow));
    assert.equal(Boolean(broken.local[STATE].session), false, `${failure} mismatch must not establish a session`);
    assert.equal(broken.calls.some((call) => call.url.includes("/rest/")), false);
    assert.ok(broken.local[STATE].error);
  }
}

async function refreshAndOwnership() {
  for (const expired of [true, false]) {
    let reads = 0;
    const h = harness({ stored: { [STATE]: signedState({ session: { ...signedState().session, expiresAt: expired ? 1 : Date.now() + 3600000 } }) }, fetch(call, { local }) {
      if (call.url.includes("grant_type=refresh_token")) {
        assert.deepEqual(call.body, { refresh_token: "refresh-old" });
        return response(token());
      }
      if (!expired && reads++ === 0) return response({ error: "access-old must never be shown" }, 401);
      assert.equal(local[STATE].session.refreshToken, "refresh-new", "Token rotation is durable before using the replacement access token");
      assert.equal(call.headers.Authorization, "Bearer access-new");
      return response([{ revision: 1, payload: {} }]);
    } });
    await h.runtime.ready;
    assert.equal((await h.message("sync")).ok, true);
    assert.equal(h.calls.filter((call) => call.url.includes("grant_type=refresh_token")).length, 1);
  }
  const mismatch = harness({ stored: { [STATE]: signedState({ owner: { userId: OTHER_USER, project: PROJECT } }) } });
  await mismatch.runtime.ready;
  assert.equal((await mismatch.message("sync")).ok, false);
  assert.equal(mismatch.calls.length, 0);
  const rotated = harness({ stored: { [STATE]: signedState({ session: { ...signedState().session, expiresAt: 1 } }) }, fetch: () => response(token(OTHER_USER)) });
  await rotated.runtime.ready;
  assert.equal((await rotated.message("sync")).ok, false);
  assert.equal(rotated.local[STATE].session.refreshToken, "refresh-old");
  assert.equal(rotated.calls.length, 1, "An account-changing refresh cannot read or write account data");
}

async function syncConflictsAndConcurrentEdits() {
  let reads = 0;
  let patches = 0;
  const base = { includeBackgrounds: false, mediaLayout: "grid" };
  const h = harness({
    stored: { ...base, includeBackgrounds: true, destinationFolder: "private/device/path", "gallery:private": "PRIVATE_MARKER", [STATE]: signedState({ base }) },
    session: { mediaLayout: "PRIVATE_MARKER", [PRIVATE_IGNORE]: 100, "downloadLedger:v1": { PRIVATE_MARKER: true } },
    async fetch(call) {
      if (call.method === "GET") {
        if (new URL(call.url).searchParams.get("select") === "revision") return response([{ revision: reads + 1 }]);
        reads += 1;
        if (reads === 1) assert.equal((await h.write({ mediaLayout: "list" })).ok, true);
        return response([{ revision: reads, payload: { ...base, filenameTemplate: reads === 1 ? "{filename}" : "{index}-{filename}" } }]);
      }
      patches += 1;
      if (patches === 1) return response([]); // Another device changed the conditional revision.
      assert.equal(new URL(call.url).searchParams.get("revision"), "eq.2");
      assert.equal(call.body.revision, 3);
      assert.deepEqual(call.body.payload, { ...base, includeBackgrounds: true, filenameTemplate: "{index}-{filename}" });
      return response([{ revision: 3, payload: call.body.payload }]);
    }
  });
  await h.runtime.ready;
  assert.equal((await h.message("sync")).ok, true);
  assert.equal(reads, 2);
  assert.equal(patches, 2);
  assert.equal(h.local.mediaLayout, "list", "A local edit during HTTP work survives remote application");
  assert.equal(h.local.filenameTemplate, "{index}-{filename}");
  assert.equal(h.local[STATE].base.mediaLayout, "grid", "Unsynced edits remain distinguishable from the remote base");
  assert.equal(h.local[STATE].journal, null);
  assert.ok(h.alarms.some((alarm) => alarm.name === "anydownload-cloud-sync-changes"));
  for (const call of h.calls) {
    assert.equal(call.credentials, "omit");
    assert.equal(call.redirect, "error");
    assert.equal(call.referrerPolicy, "no-referrer");
    assert.equal(JSON.stringify(call.body || {}).includes("PRIVATE_MARKER"), false);
    assert.equal(JSON.stringify(call.body || {}).includes("private/device/path"), false);
    assert.equal(JSON.stringify(call.body || {}).includes(PRIVATE_IGNORE), false);
  }
  assert.equal(h.temporary.mediaLayout, "PRIVATE_MARKER");

  let attempts = 0;
  const creationRace = harness({ stored: { includeBackgrounds: true, [STATE]: signedState() }, fetch(call) {
    if (call.method === "GET") return response([]);
    attempts += 1;
    return attempts === 1 ? response({}, 409) : response([{ revision: 1, payload: call.body.payload }]);
  } });
  await creationRace.runtime.ready;
  assert.equal((await creationRace.message("sync")).ok, true);
  assert.equal(attempts, 2, "Concurrent row creation retries after a uniqueness conflict");

  const unchanged = harness({ stored: { ...base, [STATE]: signedState({ base, revision: 7 }) }, fetch: () => response([{ revision: 7 }]) });
  await unchanged.runtime.ready;
  assert.equal((await unchanged.message("sync")).ok, true);
  assert.equal(unchanged.calls.length, 1, "An unchanged revision needs no full snapshot download or upload");
  assert.equal(new URL(unchanged.calls[0].url).searchParams.get("select"), "revision");
  assert.deepEqual(Model.snapshot(unchanged.local), base);
}

async function revokedPermissions() {
  for (const permission of ["origins", "data"]) {
    const h = harness({ stored: { includeBackgrounds: true, [STATE]: signedState() } });
    await h.runtime.ready;
    h.permissions[permission] = permission === "origins" ? false : [];
    assert.equal((await h.message("sync")).ok, false);
    assert.equal(h.calls.length, 0);
  }
  const h = harness({ stored: { includeBackgrounds: true, [STATE]: signedState() }, async fetch(call) {
    h.permissions.origins = false;
    await h.browser.permissions.onRemoved.emit({ origins: [`${PROJECT}/*`] });
    assert.equal(call.signal.aborted, true);
    return response([]); // Simulate an HTTP response arriving despite cancellation.
  } });
  await h.runtime.ready;
  assert.equal((await h.message("sync")).ok, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assert.equal(h.local.includeBackgrounds, true);
  assert.equal(h.local[STATE].journal, undefined);
}

async function journalRecovery() {
  const remote = { mediaLayout: "list" };
  const damaged = harness({ stored: { [STATE]: signedState({ journal: { target: { unexpected: true }, remote } }) } });
  await damaged.runtime.ready;
  assert.equal((await damaged.message("signout")).ok, true, "An invalid journal must not prevent signing out");
  assert.equal(damaged.local[STATE].session, null);
  assert.ok(damaged.local[STATE].journal, "Signing out retains interrupted data for recovery");
  for (const operation of ["set", "remove"]) {
    const h = harness({ stored: { includeBackgrounds: true, [IGNORE]: 100, mediaLayout: "grid", destinationFolder: "device/path", [STATE]: signedState({ journal: { target: remote, remote } }) } });
    let interrupted = false;
    h.hooks[operation] = async (values) => {
      if (interrupted || operation === "set" && !Object.hasOwn(values, "mediaLayout")) return;
      interrupted = true;
      if (operation === "remove") delete h.local[values[0]]; // Browser stopped after a partial removal.
      throw new Error("Simulated storage interruption");
    };
    await h.runtime.ready;
    assert.equal(interrupted, true);
    assert.ok(h.local[STATE].journal, "The journal survives interrupted settings application");
    assert.equal(h.calls.length, 0);
    const restarted = harness({ stored: h.local });
    await restarted.runtime.ready;
    assert.deepEqual(Model.snapshot(restarted.local), remote);
    assert.equal(restarted.local.destinationFolder, "device/path");
    assert.equal(restarted.local[STATE].journal, null);
    assert.deepEqual(restarted.local[STATE].base, remote);
    assert.equal(restarted.local[STATE].error, "");
    assert.equal(restarted.calls.length, 0, "Startup recovery requires no cloud access");
    assert.equal((await restarted.write({ includeBackgrounds: false })).ok, true);
    assert.equal(restarted.local.includeBackgrounds, false);
  }
}

async function automaticDevices() {
  let row;
  let offline = false;
  const fetch = call => {
    if (offline) throw new TypeError("Network unavailable");
    if (call.method === "GET") return response(row ? [new URL(call.url).searchParams.get("select") === "revision" ? { revision: row.revision } : row] : []);
    if (call.method === "PATCH" && new URL(call.url).searchParams.get("revision") !== `eq.${row.revision}`) return response([]);
    row = { revision: call.body.revision, payload: call.body.payload };
    return response([row]);
  };
  const first = harness({ stored: { [STATE]: signedState() }, fetch });
  const previousListener = globalThis.addEventListener;
  let reconnect;
  globalThis.addEventListener = (name, listener) => { if (name === "online") reconnect = listener; };
  let second;
  try { second = harness({ stored: { [STATE]: signedState() }, fetch }); }
  finally {
    if (previousListener) globalThis.addEventListener = previousListener;
    else delete globalThis.addEventListener;
  }
  const tick = h => h.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
  await Promise.all([first.runtime.ready, second.runtime.ready]);
  assert.ok(first.alarms.some(alarm => alarm.periodInMinutes === 1));
  await first.write({ mediaLayout: "list" });
  assert.ok(first.alarms.some(alarm => alarm.name.endsWith("-changes") && alarm.when <= Date.now() + 5000));
  await first.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync-changes" });
  await tick(second);
  assert.equal(second.local.mediaLayout, "list", "Another device receives local changes without Sync now");
  offline = true;
  await second.write({ includeBackgrounds: true });
  await tick(second);
  assert.equal(second.local.includeBackgrounds, true, "Offline changes survive a failed automatic sync");
  assert.ok(second.local[STATE].error);
  offline = false;
  await reconnect();
  await tick(first);
  assert.equal(first.local.includeBackgrounds, true, "Automatic retries deliver offline edits");
  assert.equal(second.local[STATE].error, "");
  assert.equal((await second.message("pause")).autoSync, false);
  assert.ok(second.clearedAlarms.includes("anydownload-cloud-sync"));
  const count = second.calls.length;
  const alarms = second.alarms.length;
  await second.write({ mediaLayout: "grid" });
  await tick(second);
  assert.equal(second.calls.length, count, "Paused devices ignore previously queued alarms");
  assert.equal(second.alarms.length, alarms, "Paused edits do not schedule uploads");
  const pausedRestart = harness({ stored: { ...second.local, [STATE]: { ...second.local[STATE], lastSync: 0 } }, fetch });
  await pausedRestart.runtime.ready;
  assert.equal(pausedRestart.calls.length, 0, "Pause survives a browser restart");
  assert.equal((await second.message("sync")).autoSync, false, "Manual sync remains available without unpausing");
  assert.equal(row.payload.mediaLayout, "grid");
  await second.write({ filenameTemplate: "{index}-{filename}" });
  assert.equal((await second.message("resume")).autoSync, true);
  assert.equal(row.payload.filenameTemplate, "{index}-{filename}", "Resume immediately merges pending edits");
  const restart = harness({ stored: { [STATE]: signedState({ lastSync: Date.now() - 61000 }) }, fetch });
  await restart.runtime.ready;
  assert.equal(restart.local.mediaLayout, "grid", "Startup catches up after a minute away");
  await second.message("signout");
  const signedOutCalls = second.calls.length;
  await tick(second);
  assert.equal(second.calls.length, signedOutCalls);
  const signedOut = harness();
  await signedOut.runtime.ready;
  await signedOut.write({ mediaLayout: "list" });
  assert.equal(signedOut.alarms.length, 0, "Local-only users have no sync alarms");
}

async function syncProgressAndCancellation() {
  let release;
  const h = harness({ stored: { [STATE]: signedState() }, fetch: () => new Promise(resolve => { release = resolve; }) });
  await h.runtime.ready;
  const first = h.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
  while (!release) await new Promise(setImmediate);
  assert.equal((await h.message("status")).syncing, true);
  const duplicate = h.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
  const pause = h.message("pause");
  assert.equal(h.calls[0].signal.aborted, true, "Pause aborts an in-flight request immediately");
  release(response([]));
  await Promise.all([first, duplicate, pause]);
  assert.equal(h.calls.length, 1, "Repeated alarms cannot build a network backlog");
  const status = await h.message("status");
  assert.equal(status.syncing, false);
  assert.equal(status.autoSync, false);
  assert.equal(status.error, "");
  assert.equal(h.local[STATE].journal, undefined, "Cancelled responses are never applied");
}

async function integrationsSecurity() {
  const id = "33333333-3333-4333-8333-333333333333";
  const saved = { id, provider: "immich", serverUrl: "http://192.168.0.103:2283", defaultAlbumId: null };
  const secret = "immich-test-key-not-for-storage";
  let release;
  let delay = false;
  let failed = false;
  const h = harness({ stored: { [STATE]: signedState() }, async fetch(call) {
    if (call.url.endsWith("/auth/v1/logout?scope=local")) return response({});
    assert.ok(call.url.endsWith("/functions/v1/external-integrations"));
    assert.equal(call.method, "POST");
    assert.equal(call.credentials, "omit");
    assert.equal(call.redirect, "error");
    assert.equal(call.cache, "no-store");
    assert.equal(call.headers.Authorization, "Bearer access-old");
    assert.equal(call.body.userId, undefined);
    if (failed) return response({ error: secret }, 500);
    if (delay) await new Promise(resolve => { release = resolve; });
    if (call.body.action === "list") return response({ connections: [{ ...saved, apiKey: secret }] });
    if (call.body.action === "delete") return response({ deleted: true, apiKey: secret });
    return response({ connection: { ...saved, apiKey: secret }, apiKey: secret });
  } });
  await h.runtime.ready;
  const invoke = async (action, values = {}, from = h.sender("integrations/integrations.html")) =>
    (await h.browser.runtime.onMessage.emit({ type: "INTEGRATIONS", action, ...values }, from))[0];
  const status = await invoke("status");
  assert.deepEqual(status, { ok: true, signedIn: true, ownerId: USER, email: "user@example.test" });
  const listed = await invoke("list");
  assert.deepEqual(listed, { ok: true, connections: [saved] });
  assert.equal(JSON.stringify(listed).includes(secret), false);
  for (const from of [h.sender("popup/popup.html"), h.sender("sync/sync.html"), h.sender("content/collector.js"),
    h.sender("upload/upload.html", { tab: { incognito: true } }),
    h.sender("integrations/integrations.html", { id: "other@test" }),
    h.sender("integrations/integrations.html", { url: "https://evil.test/integrations/integrations.html" })]) {
    assert.equal((await invoke("credential", { connectionId: id }, from)).ok, false);
  }
  assert.equal((await invoke("save", { provider: "immich", serverUrl: saved.serverUrl, apiKey: secret }, h.sender("upload/upload.html"))).ok, false);
  const credential = await invoke("credential", { connectionId: id }, h.sender("upload/upload.html"));
  assert.deepEqual(credential, { ok: true, connection: saved, apiKey: secret, ownerId: USER });
  const count = h.calls.length;
  for (const values of [{ connectionId: id, userId: OTHER_USER }, { connectionId: id, token: "forged" }, { connectionId: "bad-id" }]) {
    assert.equal((await invoke("credential", values)).ok, false);
  }
  assert.equal(h.calls.length, count, "Extra authorization fields and bad IDs never reach the endpoint");
  const beforeDefault = h.notifications.length;
  assert.equal((await invoke("defaultAlbum", { connectionId: id, defaultAlbumId: null }, h.sender("upload/upload.html"))).ok, true);
  assert.equal(h.notifications.length, beforeDefault, "Saving an album does not invalidate an upcoming upload");
  assert.equal((await invoke("save", { connectionId: id, provider: "immich", serverUrl: saved.serverUrl, apiKey: secret })).ok, true);
  assert.equal(h.notifications.at(-1).type, "INTEGRATIONS_CHANGED");
  assert.equal(JSON.stringify(h.local).includes(secret), false);
  failed = true;
  const failure = await invoke("credential", { connectionId: id });
  assert.deepEqual(failure, { ok: false, code: "failed" });
  assert.equal(JSON.stringify(h.local).includes(secret), false, "Credential error responses never enter durable sync error reporting");
  assert.equal(h.local[STATE].error, undefined);
  failed = false;
  delay = true;
  const pending = invoke("credential", { connectionId: id });
  while (!release) await new Promise(setImmediate);
  const signout = h.message("signout");
  assert.equal(h.notifications.at(-1).type, "INTEGRATIONS_CHANGED", "Signout invalidates keys before its queued state write");
  release();
  assert.equal((await pending).ok, false, "A key arriving after signout was requested is discarded");
  await signout;
  assert.equal((await invoke("status")).signedIn, false);
  assert.equal((await invoke("credential", { connectionId: id })).ok, false);

  let releaseList;
  const queued = harness({ stored: { [STATE]: signedState() }, async fetch(call) {
    if (call.url.includes("/auth/v1/logout")) return response({});
    if (call.body.action === "list") await new Promise(resolve => { releaseList = resolve; });
    return response(call.body.action === "credential" ? { connection: saved, apiKey: secret } : { connections: [] });
  } });
  await queued.runtime.ready;
  const queue = action => queued.browser.runtime.onMessage.emit({ type: "INTEGRATIONS", action,
    ...(action === "credential" ? { connectionId: id } : {}) }, queued.sender("upload/upload.html")).then(results => results[0]);
  const blockedList = queue("list");
  while (!releaseList) await new Promise(setImmediate);
  const queuedCredential = queue("credential");
  const queuedSignout = queued.message("signout");
  releaseList();
  assert.deepEqual(await queuedCredential, { ok: false, code: "stopped" },
    "Signout invalidates credentials queued before it, even if they have not started yet");
  await Promise.all([blockedList, queuedSignout]);
  assert.equal(queued.calls.some(call => call.body?.action === "credential"), false,
    "An invalidated queued credential never reaches the backend");

  const wrongOwner = harness({ stored: { [STATE]: signedState({ owner: { userId: OTHER_USER, project: PROJECT } }) } });
  await wrongOwner.runtime.ready;
  const denied = (await wrongOwner.browser.runtime.onMessage.emit({ type: "INTEGRATIONS", action: "credential", connectionId: id }, wrongOwner.sender("upload/upload.html")))[0];
  assert.equal(denied.ok, false);
  assert.equal(wrongOwner.calls.length, 0, "A mismatched owner cannot retrieve another account's key");
}

(async () => {
  for (const check of [consentAndTrust, sharedProjectMigration, authentication, refreshAndOwnership, syncConflictsAndConcurrentEdits, revokedPermissions, journalRecovery, automaticDevices, syncProgressAndCancellation, integrationsSecurity]) await check();
  console.log("Cloud sync runtime tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
