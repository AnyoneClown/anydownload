"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CONFIG } = require("../extension/shared/cloud-sync-runtime.js");

const html = fs.readFileSync(path.join(__dirname, "../extension/sync/sync.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../extension/sync/sync.js"), "utf8");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

async function openPage(options = {}) {
  const nodes = Object.fromEntries([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, {
    id, value: "", checked: false, hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
    attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
    listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }
  }]));
  const documentListeners = {};
  let poll;
  const messages = [];
  const requests = [];
  let permissionResolver;
  let changeListener;
  let current = { ok: true, configured: true, consent: false, signedIn: false, config: CONFIG, ...options.status };
  const context = {
    URL, Date, console, setInterval: callback => { poll = callback; return 1; }, clearInterval() {},
    document: {
      querySelectorAll: () => Object.values(nodes),
      addEventListener: (name, callback) => { documentListeners[name] = callback; }
    },
    addEventListener() {},
    browser: {
      extension: { inIncognitoContext: Boolean(options.extensionPrivate) },
      tabs: { getCurrent: async () => ({ incognito: Boolean(options.tabPrivate) }) },
      permissions: {
        getAll: async () => options.legacy ? { origins: [] } : { origins: [], data_collection: [] },
        request: value => {
          requests.push(JSON.parse(JSON.stringify(value)));
          return new Promise(resolve => { permissionResolver = resolve; });
        }
      },
      runtime: {
        sendMessage: async message => {
          messages.push(message);
          if (options.transportError) throw new Error("Access token: do-not-display");
          if (message.action === "signin") current = { ...current, signedIn: true, consent: true, accountBound: true, email: "test@example.com" };
          if (["pause", "resume"].includes(message.action)) current = { ...current, autoSync: message.action === "resume" };
          if (message.action === "signout") current = { ...current, signedIn: false };
          return current;
        }
      },
      storage: { onChanged: { addListener: callback => { changeListener = callback; } } }
    }
  };
  vm.runInNewContext(script, context);
  documentListeners.DOMContentLoaded();
  await flush();
  return {
    nodes, messages, requests,
    async updateStatus(values) { current = { ...current, ...values }; poll(); await flush(); },
    resolvePermission: granted => permissionResolver(granted),
    storageChanged: () => changeListener({ cloudSyncState: { newValue: {} } }, "local")
  };
}

async function run() {
  for (const options of [{ tabPrivate: true }, { extensionPrivate: true }]) {
    const page = await openPage(options);
    assert.equal(page.messages.length, 0, "Private sync pages cannot read account status");
    assert.equal(page.requests.length, 0);
    assert.equal(page.nodes["sync-card"].hidden, true);
    assert.equal(page.nodes["private-notice"].hidden, false);
  }

  const page = await openPage();
  const get = id => page.nodes[id];
  assert.equal(get("sync-card").hidden, false);
  assert.equal(get("project-url"), undefined, "Users never configure the shared project");
  assert.equal(get("public-key"), undefined);
  assert.equal(get("sync-consent").checked, false, "Bundled configuration is not consent");
  assert.equal(get("signin-button").disabled, true);
  get("signin-button").listeners.click();
  assert.equal(page.requests.length, 0, "A click cannot bypass unchecked consent");
  get("sync-consent").checked = true;
  get("sync-consent").listeners.change();
  assert.equal(get("signin-button").disabled, false);
  get("signin-button").listeners.click();
  assert.equal(page.requests.length, 1, "Permission is requested synchronously from the click handler");
  assert.deepEqual(page.requests[0], {
    origins: [`${CONFIG.url}/*`],
    data_collection: ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity", "websiteActivity", "websiteContent"]
  });
  assert.equal(page.messages.length, 1, "Sign-in waits for permission approval");
  page.resolvePermission(false);
  await flush();
  assert.equal(page.messages.length, 1, "Denied permission must not start sign-in");
  assert.match(get("error-banner").textContent, /not granted/);
  page.storageChanged();
  await flush();
  assert.equal(get("sync-consent").checked, true, "Status refresh preserves the user's consent choice");
  get("signin-button").listeners.click();
  page.resolvePermission(true);
  await flush();
  assert.equal(page.messages.at(-1).action, "signin", "One click signs in without a configuration step");
  assert.equal(page.messages.at(-1).consent, true);
  assert.equal(page.messages.at(-1).config, undefined);
  assert.match(get("account-email").textContent, /test@example.com/);
  const beforeSync = page.requests.length;
  get("sync-button").listeners.click();
  assert.equal(page.requests.length, beforeSync + 1, "Sync now can restore permissions without signing out");
  page.resolvePermission(true);
  await flush();
  assert.equal(page.messages.at(-1).action, "sync");
  get("signout-button").listeners.click();
  await flush();
  assert.equal(page.messages.at(-1).action, "signout");
  assert.equal(get("account-note").hidden, false);
  const beforeSignin = page.requests.length;
  get("signin-button").listeners.click();
  assert.equal(page.requests.length, beforeSignin + 1, "Re-login re-requests revoked permissions in the click stack");
  page.resolvePermission(true);
  await flush();

  const legacy = await openPage({ legacy: true });
  legacy.nodes["sync-consent"].checked = true;
  legacy.nodes["signin-button"].listeners.click();
  assert.deepEqual(legacy.requests[0], { origins: [`${CONFIG.url}/*`] });
  legacy.resolvePermission(false);
  await flush();
  const returning = await openPage({ status: { consent: true, signedIn: true, accountBound: true } });
  assert.equal(returning.nodes["sync-consent"].checked, true);
  assert.equal(returning.nodes["sync-consent"].disabled, true);
  assert.equal(returning.nodes["sync-button"].hidden, false);
  assert.equal(returning.requests.length, 0, "Opening an account page does not prompt for permissions");

  assert.equal(returning.nodes["setup-section"].hidden, true);
  assert.equal(returning.nodes["automatic-section"].hidden, false);
  returning.nodes["auto-button"].listeners.click();
  await flush();
  assert.equal(returning.messages.at(-1).action, "pause");
  assert.equal(returning.requests.length, 0, "Pausing does not need new permissions");
  assert.equal(returning.nodes["auto-button"].attributes["aria-checked"], "false");
  assert.equal(returning.nodes["status-badge"].textContent, "Paused");
  returning.nodes["auto-button"].listeners.click();
  assert.equal(returning.requests.length, 1, "Resuming can restore revoked permissions in the click stack");
  returning.resolvePermission(true);
  await flush();
  assert.equal(returning.nodes["auto-button"].attributes["aria-checked"], "true");
  await returning.updateStatus({ syncing: true });
  assert.equal(returning.nodes["sync-button"].disabled, true);
  assert.equal(returning.nodes["status-badge"].textContent, "Syncing…");
  await returning.updateStatus({ syncing: false, permissionGranted: false });
  assert.equal(returning.nodes["sync-button"].textContent, "Allow permissions & sync");
  await returning.updateStatus({ permissionGranted: true, lastSync: Date.now(), error: "" });
  assert.match(returning.nodes["last-sync"].textContent, /just now/);
  const pending = await openPage({ status: { pendingLogin: true } });
  assert.equal(pending.nodes["setup-section"].hidden, true);
  assert.equal(pending.nodes["signin-button"].hidden, true);
  assert.equal(pending.nodes["signout-button"].textContent, "Cancel sign-in");
  await pending.updateStatus({ pendingLogin: false });
  assert.equal(pending.nodes["setup-section"].hidden, false, "Expired login is refreshed without user interaction");

  const failed = await openPage({ transportError: true });
  assert.equal(failed.nodes["error-banner"].hidden, false);
  assert.doesNotMatch(failed.nodes["error-banner"].textContent, /do-not-display|token/i);
  console.log("Cloud sync UI tests passed: private isolation, explicit consent, permissions, account binding, and safe status updates.");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
