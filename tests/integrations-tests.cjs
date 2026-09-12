"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Integrations = require("../extension/shared/integrations.js");
const Immich = require("../extension/shared/immich.js");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const saved = { id: "33333333-3333-4333-8333-333333333333", provider: "immich", serverUrl: "http://192.168.0.103:2283", defaultAlbumId: null };
const KEY = "test-key-must-stay-in-memory";
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };

function event() {
  const listeners = new Set();
  return { addListener: value => listeners.add(value), removeListener: value => listeners.delete(value),
    emit: (...args) => Promise.all([...listeners].map(value => value(...args))), listeners };
}

function harness(options = {}) {
  const messages = [];
  const requests = [];
  const state = { signedIn: true, ownerId: USER, permission: true, connection: saved, ...options };
  let resolvePermission;
  const browser = {
    extension: { inIncognitoContext: Boolean(options.extensionPrivate) },
    tabs: { async getCurrent() { return { incognito: Boolean(options.tabPrivate) }; } },
    runtime: {
      id: "anydownload@test", onMessage: event(),
      async sendMessage(value) {
        messages.push(structuredClone(value));
        if (options.onMessage) {
          const intercepted = await options.onMessage(value, state, browser);
          if (intercepted !== undefined) return intercepted;
        }
        if (value.action === "status") return { ok: true, signedIn: state.signedIn, ownerId: state.ownerId, email: "user@example.test" };
        if (value.action === "list") return { ok: true, connections: [{ ...state.connection, apiKey: KEY }] };
        if (value.action === "credential") return { ok: true, connection: state.connection, apiKey: KEY, ownerId: state.ownerId };
        if (value.action === "save") {
          await browser.runtime.onMessage.emit({ type: "INTEGRATIONS_CHANGED" }, { id: browser.runtime.id });
          return { ok: true, connection: state.connection };
        }
        if (value.action === "delete") return { ok: true, deleted: true };
        if (value.action === "defaultAlbum") return { ok: true, connection: { ...state.connection, defaultAlbumId: value.defaultAlbumId } };
        throw new Error(KEY);
      }
    },
    storage: { onChanged: event() },
    permissions: {
      onRemoved: event(), contains: async () => state.permission,
      request(value) { requests.push(structuredClone(value)); return new Promise(resolve => { resolvePermission = resolve; }); }
    }
  };
  return { browser, state, messages, requests, grant: value => resolvePermission(value) };
}

async function clientChecks() {
  const h = harness();
  const client = Integrations.create(h.browser);
  assert.deepEqual(await client.list(), [saved], "Ordinary metadata drops secret fields");
  let captured;
  const output = await client.withCredential(saved, async (credential, { signal }) => {
    captured = credential;
    assert.equal(credential.apiKey, KEY);
    assert.equal(signal.aborted, false);
    return "asset-result";
  });
  assert.equal(output, "asset-result");
  assert.equal(captured.apiKey, "", "Credentials are cleared after the scoped operation");
  h.state.permission = false;
  await assert.rejects(client.withCredential(saved, () => assert.fail("Missing permissions must not call Immich")), /Allow Firefox/);
  h.state.permission = true;
  h.state.connection = { ...saved, serverUrl: "https://another-immich.test" };
  await assert.rejects(client.withCredential(saved, () => assert.fail("Origin changes must not call Immich")), /saved connection changed/);
  h.state.connection = saved;

  for (const invalidate of [
    () => h.browser.permissions.onRemoved.emit({ origins: ["http://192.168.0.103/*"] }),
    () => h.browser.runtime.onMessage.emit({ type: "INTEGRATIONS_CHANGED" }, { id: h.browser.runtime.id }),
    () => h.browser.storage.onChanged.emit({ "cloudSync:v1": { oldValue: { session: { userId: USER } }, newValue: { session: { userId: OTHER } } } }, "local"),
    () => h.browser.storage.onChanged.emit({ "cloudSync:v1": { oldValue: { owner: { project: "https://first.supabase.co" } }, newValue: { owner: { project: "https://second.supabase.co" } } } }, "local"),
    () => client.cancel()
  ]) {
    let release;
    let signal;
    const running = client.withCredential(saved, async (credential, options) => {
      captured = credential;
      signal = options.signal;
      await new Promise(resolve => { release = resolve; });
    });
    while (!release) await new Promise(setImmediate);
    await invalidate();
    assert.equal(captured.apiKey, "");
    assert.equal(signal.aborted, true);
    release();
    await assert.rejects(running, /cancelled/);
  }
  client.dispose();
  assert.equal(h.browser.storage.onChanged.listeners.size, 0);
  assert.equal(h.browser.runtime.onMessage.listeners.size, 0);
  assert.equal(h.browser.permissions.onRemoved.listeners.size, 0);
  for (const options of [{ extensionPrivate: true }, { tabPrivate: true }]) {
    const privateHarness = harness(options);
    const privateClient = Integrations.create(privateHarness.browser);
    await assert.rejects(privateClient.status(), /private/);
    assert.equal(privateHarness.messages.length, 0);
    privateClient.dispose();
  }
  const changed = harness({ onMessage: async (message, state) => {
    if (message.action === "credential") {
      state.ownerId = OTHER;
      return { ok: true, connection: saved, apiKey: KEY, ownerId: USER };
    }
  } });
  const changedClient = Integrations.create(changed.browser);
  await assert.rejects(changedClient.withCredential(saved, () => assert.fail("Changing accounts cannot reuse a key")), /changed/);
  changedClient.dispose();
  let releaseCredential;
  const pendingPayload = { ok: true, connection: saved, apiKey: KEY, ownerId: USER };
  const pendingHarness = harness({ onMessage: message => message.action === "credential"
    ? new Promise(resolve => { releaseCredential = () => resolve(pendingPayload); }) : undefined });
  const pendingClient = Integrations.create(pendingHarness.browser);
  const pendingScope = pendingClient.withCredential(saved, () => assert.fail("An invalidated pending credential must not reach Immich"));
  while (!releaseCredential) await new Promise(setImmediate);
  await pendingHarness.browser.runtime.onMessage.emit({ type: "INTEGRATIONS_CHANGED" }, { id: pendingHarness.browser.runtime.id });
  releaseCredential();
  await assert.rejects(pendingScope, /changed/);
  assert.equal(pendingPayload.apiKey, "", "Late credential responses are cleared even when access was invalidated in flight");
  pendingClient.dispose();
  const failed = harness({ onMessage: () => { throw new Error(KEY); } });
  const failedClient = Integrations.create(failed.browser);
  await assert.rejects(failedClient.status(), error => !error.message.includes(KEY));
  failedClient.dispose();
  assert.throws(() => Integrations.connection({ ...saved, serverUrl: "https://key:password@server.test" }));
  assert.throws(() => Integrations.connection({ ...saved, serverUrl: "https://server.test/path" }));
  assert.equal(Integrations.validKey("key\r\nx-header:secret"), false);
}

async function openPage(options = {}) {
  const html = fs.readFileSync(path.join(__dirname, "../extension/integrations/integrations.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../extension/integrations/integrations.js"), "utf8");
  const nodes = Object.fromEntries([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, {
    id, value: "", hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag), textContent: "",
    options: [], listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
    replaceChildren(...values) { this.options = values; }, add(value) { this.options.push(value); }
  }]));
  const h = harness(options);
  const lifecycle = {};
  let initialize;
  const tests = [];
  const context = {
    URL, AbortController, console,
    Option: function Option(label, value) { this.label = label; this.value = value; },
    document: { querySelectorAll: () => Object.values(nodes), addEventListener(_name, callback) { initialize = callback; } },
    addEventListener(name, callback) { lifecycle[name] = callback; },
    browser: h.browser, AnyDownloadIntegrations: Integrations,
    ImageDownloaderImmich: { ...Immich, async testConnection(credential, { signal }) {
      tests.push({ ...credential });
      if (options.failedTest) throw new Immich.ImmichError("invalid_key");
      assert.equal(signal.aborted, false);
      return { permissions: ["asset.upload"], canUseAlbums: false };
    } }
  };
  vm.runInNewContext(script, context);
  initialize();
  await flush();
  return { ...h, nodes, tests, lifecycle };
}

async function settingsChecks() {
  for (const options of [{ extensionPrivate: true }, { tabPrivate: true }]) {
    const page = await openPage(options);
    assert.equal(page.nodes.content.hidden, true);
    assert.equal(page.nodes["private-notice"].hidden, false);
    assert.equal(page.messages.length, 0, "Private settings cannot load the normal account");
  }
  const page = await openPage();
  const { nodes } = page;
  nodes["server-url"].value = `${saved.serverUrl}/albums`;
  nodes["api-key"].value = KEY;
  const save = nodes["connection-form"].listeners.submit({ preventDefault() {} });
  assert.deepEqual(page.requests, [{ origins: ["http://192.168.0.103/*"] }], "Permission is requested directly in the user gesture");
  assert.equal(nodes["api-key"].value, "", "The field is cleared as soon as its temporary operation starts");
  assert.equal(page.tests.length, 0);
  assert.equal(page.messages.some(value => value.action === "save"), false);
  page.grant(true);
  await save;
  assert.deepEqual(page.tests, [{ serverUrl: saved.serverUrl, apiKey: KEY }]);
  const sent = page.messages.find(value => value.action === "save");
  assert.equal(sent.serverUrl, saved.serverUrl);
  assert.equal(sent.apiKey, KEY);
  assert.equal(sent.userId, undefined);
  assert.equal(nodes["api-key"].value, "");
  assert.match(nodes.status.textContent, /tested and saved/);
  assert.match(nodes.status.textContent, /Library uploads/);
  assert.equal(nodes["server-url"].disabled, true, "A replacement cannot silently change server origin");
  nodes["api-key"].value = "another-temporary-key";
  await page.browser.runtime.onMessage.emit({ type: "INTEGRATIONS_CHANGED" }, { id: page.browser.runtime.id });
  assert.equal(nodes["api-key"].value, "", "Signout and disconnect broadcasts clear manually pasted keys");
  await flush();
  await nodes.disconnect.listeners.click();
  assert.equal(page.messages.at(-3).action === "delete" || page.messages.some(value => value.action === "delete"), true);
  assert.match(nodes.status.textContent, /encrypted key deleted/);
  page.lifecycle.pagehide();

  const replacing = await openPage({ connection: { ...saved, defaultAlbumId: OTHER } });
  replacing.nodes.connections.value = saved.id;
  replacing.nodes.connections.listeners.change();
  assert.equal(replacing.nodes["server-url"].disabled, true);
  assert.equal(replacing.nodes["api-key"].value, "");
  replacing.nodes["api-key"].value = KEY;
  const replacement = replacing.nodes["connection-form"].listeners.submit({ preventDefault() {} });
  replacing.grant(true);
  await replacement;
  const replacementMessage = replacing.messages.find(value => value.action === "save");
  assert.equal(replacementMessage.connectionId, saved.id);
  assert.equal(replacementMessage.defaultAlbumId, OTHER, "Replacing a key preserves the remembered default album");
  replacing.lifecycle.pagehide();

  for (const denied of [true, false]) {
    const failed = await openPage({ failedTest: !denied });
    failed.nodes["server-url"].value = saved.serverUrl;
    failed.nodes["api-key"].value = KEY;
    const pending = failed.nodes["connection-form"].listeners.submit({ preventDefault() {} });
    failed.grant(!denied);
    await pending;
    assert.equal(failed.messages.some(value => value.action === "save"), false, "Denied permissions or invalid API keys are never saved");
    assert.equal(failed.nodes.error.hidden, false);
    assert.equal(failed.nodes.error.textContent.includes(KEY), false);
    assert.equal(failed.nodes["api-key"].value, "");
    failed.lifecycle.pagehide();
  }
}

(async () => {
  await clientChecks();
  await settingsChecks();
  console.log("Integration client and settings tests passed: scoped credentials, origin binding, invalidation, privacy, permissions and tested saves.");
})().catch(error => { console.error(error); process.exitCode = 1; });
