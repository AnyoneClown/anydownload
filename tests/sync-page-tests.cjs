"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../extension/sync/sync.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../extension/sync/sync.js"), "utf8");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

async function openPage(options = {}) {
  const nodes = Object.fromEntries([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, {
    id, value: "", checked: false, hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
    listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }
  }]));
  const documentListeners = {};
  const messages = [];
  const requests = [];
  let permissionResolver;
  let changeListener;
  let current = { ok: true, configured: false, signedIn: false, config: { url: "", publicKey: "" } };
  const context = {
    URL, Date, console,
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
          if (message.action === "configure") current = { ...current, config: message.config, configured: true };
          if (message.action === "signin") current = { ...current, signedIn: true, accountBound: true, email: "test@example.com" };
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
  assert.equal(get("configure-button").disabled, true, "Consent must be explicit before saving a project");
  get("project-url").value = "https://testproject.supabase.co";
  get("public-key").value = "sb_publishable_test";
  get("project-url").listeners.input();
  get("config-form").listeners.submit({ preventDefault() {} });
  assert.equal(page.requests.length, 0, "A submitted form cannot bypass unchecked consent");
  get("sync-consent").checked = true;
  get("sync-consent").listeners.change();
  assert.equal(get("configure-button").disabled, false);
  get("config-form").listeners.submit({ preventDefault() {} });
  assert.equal(page.requests.length, 1, "Permission must be requested synchronously from the submit handler");
  assert.deepEqual(page.requests[0], {
    origins: ["https://testproject.supabase.co/*"],
    data_collection: ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity", "websiteActivity", "websiteContent"]
  });
  assert.equal(page.messages.length, 1, "Configuration must wait for permission approval");
  page.resolvePermission(false);
  await flush();
  assert.equal(page.messages.length, 1, "Denied consent must not configure cloud sync");
  assert.match(get("error-banner").textContent, /not granted/);
  get("config-form").listeners.submit({ preventDefault() {} });
  page.resolvePermission(true);
  await flush();
  assert.equal(page.messages.at(-1).action, "configure");
  assert.equal(page.messages.at(-1).consent, true);
  assert.equal(get("signin-button").disabled, false);

  get("public-key").value = "an-unsaved-key";
  get("public-key").listeners.input();
  page.storageChanged();
  await flush();
  assert.equal(get("public-key").value, "an-unsaved-key", "Status refresh cannot overwrite configuration edits");
  assert.equal(get("signin-button").disabled, true, "Unsaved configuration cannot start sign-in");
  get("config-form").listeners.submit({ preventDefault() {} });
  page.resolvePermission(true);
  await flush();
  const previousRequests = page.requests.length;
  get("signin-button").listeners.click();
  assert.equal(page.requests.length, previousRequests + 1, "Sign-in re-requests revoked permissions in the direct click stack");
  page.resolvePermission(true);
  await flush();
  assert.equal(get("project-url").disabled, true);
  assert.match(get("sync-status").textContent, /test@example.com/);
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
  assert.equal(get("project-url").disabled, true, "Account binding must remain visible after sign-out");
  assert.equal(get("public-key").disabled, false, "A signed-out installation can rotate its public key for the same project");

  const legacy = await openPage({ legacy: true });
  legacy.nodes["sync-consent"].checked = true;
  legacy.nodes["project-url"].value = "https://testproject.supabase.co/path";
  legacy.nodes["config-form"].listeners.submit({ preventDefault() {} });
  assert.equal(legacy.requests.length, 0, "Non-root project URLs cannot request permissions");
  legacy.nodes["project-url"].value = "https://testproject.supabase.co";
  legacy.nodes["config-form"].listeners.submit({ preventDefault() {} });
  assert.deepEqual(legacy.requests[0], { origins: ["https://testproject.supabase.co/*"] });
  legacy.resolvePermission(false);
  await flush();

  const failed = await openPage({ transportError: true });
  assert.equal(failed.nodes["error-banner"].hidden, false);
  assert.doesNotMatch(failed.nodes["error-banner"].textContent, /do-not-display|token/i);
  console.log("Cloud sync UI tests passed: private isolation, explicit consent, permissions, account binding, and safe status updates.");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
