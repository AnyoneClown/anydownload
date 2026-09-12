"use strict";

const assert = require("node:assert/strict");
const { webcrypto, createHash } = require("node:crypto");
const Runtime = require("../extension/shared/cloud-sync-runtime.js");
const Model = require("../extension/shared/cloud-sync.js");
const Core = require("../extension/shared/core.js");

const PROJECT = "https://anydownloadtest.supabase.co";
const CONFIG = { url: PROJECT, publicKey: "sb_publishable_test_public_key_12345" };
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
  const tabs = new Map();
  const alarms = [];
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
    runtime: { id: "anydownload@test", getURL: (path) => `${EXTENSION}/${path.replace(/^\//, "")}`, onMessage: event() },
    storage: { local: storage(local, "local"), session: storage(temporary, "session"), onChanged: changed },
    permissions: {
      contains: async () => permissions.origins,
      getAll: async () => permissions.data === undefined ? {} : { data_collection: [...permissions.data] },
      onRemoved: event()
    },
    alarms: { create: (name, info) => alarms.push({ name, ...info }), onAlarm: event() },
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
    browser, local, temporary, calls, tabs, alarms, hooks, permissions, sender, runtime,
    async message(action, values = {}, from = sender()) { return (await browser.runtime.onMessage.emit({ type: "CLOUD_SYNC", action, ...values }, from))[0]; },
    async write(values, from = sender("popup/popup.html")) { return (await browser.runtime.onMessage.emit({ type: "CLOUD_LOCAL_WRITE", action: "set", values }, from))[0]; },
    async callback(url, id = temporary[LOGIN].tabId, tab = { id, incognito: false }) { await browser.tabs.onUpdated.emit(id, { url }, tab); }
  };
}

async function beginLogin(h) {
  await h.runtime.ready;
  assert.equal((await h.message("configure", { consent: true, config: CONFIG })).ok, true);
  assert.equal((await h.message("signin")).ok, true);
  return clone(h.temporary[LOGIN]);
}

function callbackUrl(login) {
  return `${login.project}/functions/v1/sync-callback?state=${login.nonce}&code=one-time-code`;
}

async function consentAndTrust() {
  const h = harness();
  await h.runtime.ready;
  await h.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
  assert.equal((await h.message("signin")).ok, false);
  assert.equal((await h.message("configure", { config: CONFIG })).ok, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.tabs.size, 0);
  const serviceRole = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"role":"service_role"}').toString("base64url")}.signature`;
  for (const publicKey of ["sb_secret_test_secret_key_12345", serviceRole, "invalid-key"]) {
    assert.equal((await h.message("configure", { consent: true, config: { ...CONFIG, publicKey } })).ok, false);
  }
  for (const url of ["http://anydownloadtest.supabase.co", `${PROJECT}/path`, "https://anydownloadtest.supabase.co.evil.test", `${PROJECT}/?secret=1`]) {
    assert.equal((await h.message("configure", { consent: true, config: { ...CONFIG, url } })).ok, false);
  }
  for (const sender of [h.sender("sync/sync.html", { id: "other@extension" }), h.sender("sync/sync.html", { url: "https://evil.test/sync/sync.html" }), h.sender("popup/popup.html"), h.sender("sync/sync.html", { tab: { incognito: true } })]) {
    assert.equal((await h.message("configure", { consent: true, config: CONFIG }, sender)).ok, false);
  }
  assert.equal((await h.write({ includeBackgrounds: true }, h.sender("popup/popup.html", { tab: { incognito: true } }))).ok, false);
  assert.equal((await h.write({ "cloudSync:v1": signedState() })).ok, false);
  h.permissions.data = [];
  assert.equal((await h.message("configure", { consent: true, config: CONFIG })).ok, false);
  h.permissions.data = undefined; // Firefox versions before data_collection permission support.
  assert.equal((await h.message("configure", { consent: true, config: CONFIG })).ok, true);
  assert.equal((await h.message("sync")).ok, false);
  assert.equal(h.calls.length, 0, "Configuration does not contact the cloud or upload before sign-in");
  assert.equal(h.local.includeBackgrounds, undefined);

  const noConsent = harness({ stored: { [STATE]: signedState({ consent: false, lastSync: 0 }) } });
  await noConsent.runtime.ready;
  await noConsent.browser.alarms.onAlarm.emit({ name: "anydownload-cloud-sync" });
  assert.equal(noConsent.calls.length, 0, "A stored session never overrides withdrawn consent");
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

(async () => {
  for (const check of [consentAndTrust, authentication, refreshAndOwnership, syncConflictsAndConcurrentEdits, revokedPermissions, journalRecovery]) await check();
  console.log("Cloud sync runtime tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
