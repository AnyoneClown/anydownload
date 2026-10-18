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
        if (value.action === "list") return { ok: true, connections: state.connection ? [{ ...state.connection, apiKey: KEY }] : [] };
        if (value.action === "credential") return { ok: true, connection: state.connection, apiKey: KEY, ownerId: state.ownerId };
        if (value.action === "save") {
          state.connection ||= { ...saved, serverUrl: value.serverUrl };
          await browser.runtime.onMessage.emit({ type: "INTEGRATIONS_CHANGED" }, { id: browser.runtime.id });
          return { ok: true, connection: state.connection };
        }
        if (value.action === "delete") { state.connection = null; return { ok: true, deleted: true }; }
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
    id, value: "", hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
    href: /\bhref="([^"]*)"/.exec(tag)?.[1] || "",
    textContent: html.slice(html.indexOf(tag) + tag.length).split("<")[0].trim(),
    options: [], listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
    replaceChildren(...values) { this.options = values; }, add(value) { this.options.push(value); },
    setAttribute(name, value) { this[name] = value; }, focus() { context.document.activeElement = this; }
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
      if (options.onTest) return options.onTest(credential, { signal });
      if (options.failedTest) throw new Immich.ImmichError("invalid_key");
      assert.equal(signal.aborted, false);
      return { permissions: ["asset.upload"], canUseAlbums: false };
    } }
  };
  vm.runInNewContext(script, context);
  initialize();
  await flush();
  return { ...h, nodes, tests, lifecycle, activeElement: () => context.document.activeElement };
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
  assert.equal(nodes["signin-panel"].hidden, true);
  assert.equal(nodes["connection-workspace"].hidden, false);
  assert.equal(nodes.connections.value, saved.id, "Existing server data takes priority on initial load");
  assert.equal(nodes["connection-form"].hidden, true, "Replacing a saved key requires an explicit edit action");
  assert.equal(nodes["disconnect-section"].hidden, false);
  assert.equal(nodes["upload-link"].hidden, false);
  nodes.connections.value = "";
  nodes.connections.listeners.change();
  assert.equal(nodes["connection-form"].hidden, false);
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
  assert.equal(nodes["saved-connections"].hidden, true);
  assert.equal(nodes["upload-link"].hidden, true);
  assert.equal(nodes["connection-form"].hidden, false, "A confirmed disconnect returns to the new-server form");
  page.lifecycle.pagehide();

  const replacing = await openPage({ connection: { ...saved, defaultAlbumId: OTHER } });
  replacing.nodes.connections.value = saved.id;
  replacing.nodes.connections.listeners.change();
  assert.equal(replacing.nodes["server-url"].disabled, true);
  assert.equal(replacing.nodes["disconnect-section"].hidden, false);
  assert.equal(replacing.nodes["api-key"].value, "");
  replacing.nodes["replace-key-button"].listeners.click();
  assert.equal(replacing.nodes["connection-form"].hidden, false);
  assert.equal(replacing.nodes["server-field"].hidden, true);
  assert.equal(replacing.nodes["replace-key-button"]["aria-expanded"], "true");
  replacing.nodes["api-key"].value = KEY;
  const replacement = replacing.nodes["connection-form"].listeners.submit({ preventDefault() {} });
  replacing.grant(true);
  await replacement;
  const replacementMessage = replacing.messages.find(value => value.action === "save");
  assert.equal(replacementMessage.connectionId, saved.id);
  assert.equal(replacementMessage.defaultAlbumId, OTHER, "Replacing a key preserves the remembered default album");
  replacing.lifecycle.pagehide();

  const signedOut = await openPage({ signedIn: false });
  assert.equal(signedOut.nodes["account-link"].textContent, "Sign in");
  assert.equal(signedOut.nodes["signin-panel"].hidden, false);
  assert.equal(signedOut.nodes["connection-workspace"].hidden, true);
  assert.equal(signedOut.nodes["connection-form"].hidden, true);
  assert.equal(signedOut.nodes["upload-link"].hidden, true);
  assert.equal(signedOut.messages.some(value => value.action === "list"), false,
    "The signed-out state must not load saved server metadata");
  assert.equal(signedOut.nodes.save.disabled, true);
  signedOut.lifecycle.pagehide();

  for (const denied of [true, false]) {
    const failed = await openPage({ failedTest: !denied });
    failed.nodes["replace-key-button"].listeners.click();
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

async function compactPageChecks() {
  const html = fs.readFileSync(path.join(__dirname, "../extension/integrations/integrations.html"), "utf8");
  assert.match(html, /<body class="integrations-page">/);
  assert.doesNotMatch(html, /sync\/sync\.css|connection-sidebar|integration-tabs|device-steps|eyebrow/,
    "Connections must use their own compact layout without marketing or onboarding sections");
  assert.equal([...html.matchAll(/href="\.\.\/upload\/upload\.html"/g)].length, 1,
    "Only one operational Uploads link belongs on this page");
  const page = await openPage({ connection: null });
  assert.equal(page.nodes["saved-connections"].hidden, true);
  assert.equal(page.nodes["connection-form"].hidden, false);
  assert.equal(page.nodes["server-field"].hidden, false);
  assert.equal(page.nodes["server-url"].disabled, false);
  assert.equal(page.nodes.save.disabled, false);
  assert.equal(page.nodes["upload-link"].hidden, true);
  assert.equal(page.nodes["api-key"].value, "");
  assert.equal(page.messages.some(value => value.action === "credential"), false,
    "Rendering saved-server data never loads an API key");
  page.lifecycle.pagehide();

  const editor = await openPage();
  editor.nodes["replace-key-button"].listeners.click();
  assert.equal(editor.nodes["connection-form"].hidden, false);
  editor.nodes["api-key"].value = KEY;
  editor.nodes["cancel-edit"].listeners.click();
  assert.equal(editor.nodes["api-key"].value, "");
  assert.equal(editor.nodes["connection-form"].hidden, true);
  assert.equal(editor.nodes["replace-key-button"]["aria-expanded"], "false");
  editor.nodes["replace-key-button"].listeners.click();
  editor.nodes["api-key"].value = KEY;
  editor.state.connection = { ...saved, serverUrl: "https://new-origin.example.test" };
  await editor.lifecycle.focus();
  assert.equal(editor.nodes["api-key"].value, "", "A changed saved origin invalidates manually pasted credentials");
  assert.equal(editor.nodes["server-url"].value, editor.state.connection.serverUrl);
  assert.equal(editor.nodes["server-url"].disabled, true);
  assert.equal(editor.nodes["connection-form"].hidden, true, "Origin changes require a fresh explicit edit action");
  editor.state.connection = null;
  await editor.lifecycle.focus();
  assert.equal(editor.nodes["saved-connections"].hidden, true);
  assert.equal(editor.nodes["server-url"].value, "");
  assert.equal(editor.nodes["server-url"].disabled, false);
  editor.lifecycle.pagehide();
}

async function cancellationAndRefreshRaceChecks() {
  let releaseTest;
  let credential;
  let signal;
  const cancelled = await openPage({ onTest: (value, options) => {
    credential = value;
    signal = options.signal;
    return new Promise(resolve => { releaseTest = () => resolve({ canUseAlbums: true }); });
  } });
  cancelled.nodes["replace-key-button"].listeners.click();
  cancelled.nodes["api-key"].value = KEY;
  cancelled.nodes["api-key"].focus();
  const saving = cancelled.nodes["connection-form"].listeners.submit({ preventDefault() {} });
  cancelled.grant(true);
  while (!releaseTest) await flush();
  cancelled.nodes.cancel.listeners.click();
  assert.equal(credential.apiKey, "", "Cancelling clears the exact temporary credential held by the test");
  assert.equal(signal.aborted, true);
  releaseTest();
  await saving;
  assert.equal(cancelled.messages.some(value => value.action === "save"), false);
  assert.match(cancelled.nodes.status.textContent, /Cancelled/);
  assert.equal(cancelled.nodes["connection-form"].hidden, false);
  assert.equal(cancelled.nodes["api-key"].value, "");
  cancelled.lifecycle.pagehide();

  let releaseStatus;
  let initialStatus = true;
  const racing = await openPage({ onMessage: value => {
    if (value.action === "status" && initialStatus) {
      initialStatus = false;
      return new Promise(resolve => { releaseStatus = () => resolve({ ok: true, signedIn: true, ownerId: USER }); });
    }
  } });
  assert.equal(racing.nodes.content.hidden, true, "An unresolved account must not show a disabled form wall");
  assert.equal(racing.nodes["page-loading"].hidden, false);
  racing.state.ownerId = OTHER;
  racing.state.connection = { ...saved, id: OTHER, serverUrl: "https://other-account.example.test" };
  await racing.browser.storage.onChanged.emit({ "cloudSync:v1": {
    oldValue: { session: { userId: USER } }, newValue: { session: { userId: OTHER } }
  } }, "local");
  releaseStatus();
  await flush();
  assert.equal(racing.nodes.connections.value, OTHER, "A stale refresh cannot restore the previous account's selection");
  assert.equal(racing.nodes["server-url"].value, "https://other-account.example.test");
  assert.equal(racing.nodes["api-key"].value, "");
  assert.ok(racing.messages.filter(value => value.action === "status").length >= 2);
  racing.lifecycle.pagehide();

  const changed = await openPage();
  changed.nodes["replace-key-button"].listeners.click();
  changed.nodes["api-key"].value = KEY;
  const pending = changed.nodes["connection-form"].listeners.submit({ preventDefault() {} });
  changed.state.ownerId = OTHER;
  await changed.browser.storage.onChanged.emit({ "cloudSync:v1": {
    oldValue: { session: { userId: USER } }, newValue: { session: { userId: OTHER } }
  } }, "local");
  assert.equal(changed.nodes["api-key"].value, "");
  assert.equal(changed.nodes.content.hidden, true, "Identity changes hide stale account metadata until a fresh refresh completes");
  changed.grant(true);
  await pending;
  assert.equal(changed.tests.length, 0);
  assert.equal(changed.messages.some(value => value.action === "save"), false,
    "A key awaiting permission cannot cross an account change");
  changed.lifecycle.pagehide();
}

async function disconnectAndLoadFailureChecks() {
  const denied = await openPage({ onMessage: value => value.action === "delete" ? { ok: false } : undefined });
  await denied.nodes.disconnect.listeners.click();
  assert.equal(denied.nodes.connections.value, saved.id);
  assert.equal(denied.nodes["disconnect-section"].hidden, false);
  assert.equal(denied.nodes["upload-link"].hidden, false);
  assert.match(denied.nodes.error.textContent, /deletion has not been confirmed/);
  assert.equal(denied.nodes.status.textContent, "");
  denied.lifecycle.pagehide();

  let deleted = false;
  const confirmed = await openPage({ onMessage: (value, state) => {
    if (value.action === "delete") {
      deleted = true;
      state.connection = null;
      return { ok: true, deleted: true };
    }
    if (value.action === "list" && deleted) return { ok: false };
  } });
  confirmed.nodes.disconnect.focus();
  await confirmed.nodes.disconnect.listeners.click();
  assert.match(confirmed.nodes.status.textContent, /encrypted key deleted/);
  assert.equal(confirmed.nodes["saved-connections"].hidden, true,
    "A confirmed deletion must not reappear when the following metadata refresh fails");
  assert.equal(confirmed.nodes["upload-link"].hidden, true);
  assert.equal(confirmed.activeElement(), confirmed.nodes["server-url"],
    "When Disconnect disappears, focus returns to the available new-server field");
  confirmed.lifecycle.pagehide();

  let failing = true;
  const recoverable = await openPage({ onMessage: value => value.action === "status" && failing ? { ok: false } : undefined });
  assert.equal(recoverable.nodes.content.hidden, true);
  assert.equal(recoverable.nodes.error.hidden, false);
  assert.equal(recoverable.nodes["page-loading"].hidden, true);
  assert.equal(recoverable.nodes["refresh-button"].disabled, false);
  failing = false;
  await recoverable.nodes["refresh-button"].listeners.click();
  assert.equal(recoverable.nodes.content.hidden, false);
  assert.equal(recoverable.nodes.error.hidden, true, "A successful retry clears the previous load error");
  assert.equal(recoverable.nodes.connections.value, saved.id);
  recoverable.lifecycle.pagehide();
}

async function asyncFocusChecks() {
  let releaseTest;
  const saving = await openPage({ onTest: () => new Promise(resolve => {
    releaseTest = () => resolve({ canUseAlbums: true });
  }) });
  saving.nodes["replace-key-button"].listeners.click();
  saving.nodes["api-key"].value = KEY;
  saving.nodes["api-key"].focus();
  const save = saving.nodes["connection-form"].listeners.submit({ preventDefault() {} });
  saving.grant(true);
  while (!releaseTest) await flush();
  saving.nodes["upload-link"].focus();
  releaseTest();
  await save;
  assert.equal(saving.nodes["upload-link"].hidden, false);
  assert.equal(saving.nodes["connection-form"].hidden, true);
  assert.equal(saving.activeElement(), saving.nodes["upload-link"],
    "A slow key save must preserve visible focus deliberately moved to Uploads");
  saving.lifecycle.pagehide();

  let releaseDelete;
  let deleted = false;
  const second = { ...saved, id: OTHER, serverUrl: "https://second.example.test" };
  const disconnecting = await openPage({ onMessage: value => {
    if (value.action === "list") return { ok: true, connections: deleted ? [second] : [saved, second] };
    if (value.action === "delete") return new Promise(resolve => {
      releaseDelete = () => { deleted = true; resolve({ ok: true, deleted: true }); };
    });
  } });
  disconnecting.nodes.disconnect.focus();
  const disconnect = disconnecting.nodes.disconnect.listeners.click();
  while (!releaseDelete) await flush();
  disconnecting.nodes["upload-link"].focus();
  releaseDelete();
  await disconnect;
  assert.equal(disconnecting.nodes["upload-link"].hidden, false, "Another saved server still supports uploads");
  assert.equal(disconnecting.activeElement(), disconnecting.nodes["upload-link"],
    "A slow disconnect must preserve visible focus deliberately moved elsewhere");
  disconnecting.lifecycle.pagehide();

  const unchangedFocus = await openPage();
  unchangedFocus.nodes["replace-key-button"].listeners.click();
  unchangedFocus.nodes["api-key"].value = KEY;
  unchangedFocus.nodes["api-key"].focus();
  const ordinarySave = unchangedFocus.nodes["connection-form"].listeners.submit({ preventDefault() {} });
  unchangedFocus.grant(true);
  await ordinarySave;
  assert.equal(unchangedFocus.activeElement(), unchangedFocus.nodes["replace-key-button"],
    "A save still restores focus when the initiating key field becomes hidden");
  unchangedFocus.lifecycle.pagehide();
}

async function setupGuidanceChecks() {
  const signedOut = await openPage({ signedIn: false });
  assert.equal(signedOut.nodes["provider-overview"].hidden, false,
    "A signed-out page explains the supported provider before asking the user to sign in");
  assert.equal(signedOut.nodes["provider-prerequisites"].hidden, false);
  assert.equal(signedOut.nodes["upload-guide"].hidden, false);
  assert.equal(signedOut.nodes["upload-guide-title"].textContent, "After connecting");
  assert.equal(signedOut.nodes["account-link"].href, "../sync/sync.html");
  assert.equal(signedOut.nodes["upload-guide-actions"].hidden, true,
    "Setup instructions do not imply a signed-out connection is ready to upload");
  assert.equal(signedOut.nodes["connection-form"].hidden, true);
  assert.equal(signedOut.messages.some(value => value.action === "list" || value.action === "credential"), false);
  signedOut.lifecycle.pagehide();

  const empty = await openPage({ connection: null });
  assert.equal(empty.nodes["provider-overview"].hidden, false);
  assert.equal(empty.nodes["connection-form"].hidden, false);
  assert.equal(empty.nodes["add-server-button"].hidden, true,
    "A first connection uses the form directly, without an extra setup action");
  assert.equal(empty.nodes["upload-guide-title"].textContent, "After connecting");
  empty.lifecycle.pagehide();

  const savedPage = await openPage();
  assert.equal(savedPage.nodes["provider-overview"].hidden, true,
    "Saved connections take priority over introductory setup text");
  assert.equal(savedPage.nodes["upload-guide-title"].textContent, "Upload to Immich");
  assert.equal(savedPage.nodes["upload-guide-actions"].hidden, false);
  assert.equal(savedPage.nodes["media-link"].href, "../popup/popup.html");
  assert.equal(savedPage.nodes["add-server-button"].hidden, false);
  savedPage.nodes["replace-key-button"].listeners.click();
  savedPage.nodes["api-key"].value = KEY;
  savedPage.nodes["add-server-button"].listeners.click();
  assert.equal(savedPage.nodes.connections.value, "");
  assert.equal(savedPage.nodes["server-url"].value, "");
  assert.equal(savedPage.nodes["api-key"].value, "", "Adding a server cannot carry over another server's pasted key");
  assert.equal(savedPage.nodes["server-url"].disabled, false);
  assert.equal(savedPage.nodes["server-field"].hidden, false);
  assert.equal(savedPage.nodes["add-server-button"].hidden, true);
  assert.equal(savedPage.activeElement(), savedPage.nodes["server-url"],
    "The explicit Add server action starts at its required address field");
  assert.deepEqual(savedPage.requests, [], "Starting setup does not request site access or send a key");
  assert.equal(savedPage.messages.some(value => ["save", "delete", "credential"].includes(value.action)), false);
  savedPage.lifecycle.pagehide();

  let releaseStatus;
  const loading = await openPage({ onMessage: value => value.action === "status"
    ? new Promise(resolve => { releaseStatus = resolve; }) : undefined });
  assert.equal(loading.nodes["provider-overview"].hidden, false);
  assert.equal(loading.nodes["provider-prerequisites"].hidden, false);
  assert.equal(loading.nodes["page-loading"].hidden, false);
  assert.equal(loading.nodes.content.hidden, true);
  assert.equal(loading.nodes["upload-guide-actions"].hidden, true);
  releaseStatus({ ok: true, signedIn: false });
  await flush();
  assert.equal(loading.nodes["signin-panel"].hidden, false);
  loading.lifecycle.pagehide();

  let failed = true;
  const recovery = await openPage({ onMessage: value => value.action === "status" && failed ? { ok: false } : undefined });
  assert.equal(recovery.nodes["provider-overview"].hidden, false);
  assert.equal(recovery.nodes["load-error-actions"].hidden, false);
  assert.equal(recovery.nodes["error-account-link"].href, "../sync/sync.html");
  assert.equal(recovery.nodes["retry-load"].disabled, false);
  recovery.nodes["retry-load"].focus();
  failed = false;
  await recovery.nodes["retry-load"].listeners.click();
  assert.equal(recovery.nodes["load-error-actions"].hidden, true);
  assert.equal(recovery.nodes.error.hidden, true);
  assert.equal(recovery.nodes.connections.value, saved.id);
  assert.equal(recovery.activeElement(), recovery.nodes.connections,
    "A successful retry moves focus from its removed recovery control to the loaded server");
  recovery.lifecycle.pagehide();

  const privatePage = await openPage({ tabPrivate: true });
  assert.equal(privatePage.nodes["provider-overview"].hidden, false);
  assert.equal(privatePage.nodes["provider-prerequisites"].hidden, true,
    "Private guidance prioritizes switching windows over collecting credentials");
  assert.equal(privatePage.nodes["upload-guide"].hidden, true);
  assert.equal(privatePage.nodes["page-actions"].hidden, true);
  assert.equal(privatePage.nodes["private-notice"].hidden, false);
  assert.equal(privatePage.messages.length, 0, "Private setup guidance cannot expose or load normal-account connections");
}

(async () => {
  await clientChecks();
  await settingsChecks();
  await compactPageChecks();
  await cancellationAndRefreshRaceChecks();
  await disconnectAndLoadFailureChecks();
  await asyncFocusChecks();
  await setupGuidanceChecks();
  console.log("Integration client and settings tests passed: scoped credentials, origin binding, invalidation, privacy, permissions and tested saves.");
})().catch(error => { console.error(error); process.exitCode = 1; });
