(function attachCloudRuntime(root, factory) {
  "use strict";
  const api = factory(root.AnyDownloadCloudSync, root.ImageDownloaderCore);
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./cloud-sync.js"), require("./core.js"));
  } else {
    root.AnyDownloadCloudRuntime = api;
  }
})(globalThis, function createCloudRuntime(Model, Core) {
  "use strict";

  const STATE_KEY = "cloudSync:v1";
  const LOGIN_KEY = "cloudLogin:v1";
  const ALARM = "anydownload-cloud-sync";
  const CHANGE_ALARM = `${ALARM}-changes`;
  const DATA_TYPES = ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity", "websiteActivity", "websiteContent"];
  const CALLBACK_PATH = "/functions/v1/sync-callback";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function config(value) {
    const url = new URL(String(value && value.url || "").trim());
    if (url.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) ||
        url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Enter your HTTPS Supabase project URL, without a path.");
    }
    const publicKey = String(value && value.publicKey || "").trim();
    let publicRole = false;
    if (/^eyJ[A-Za-z0-9_.-]+$/.test(publicKey) && publicKey.length < 4096) {
      try {
        publicRole = JSON.parse(atob(publicKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "anon";
      } catch (_error) { /* Reject malformed or privileged keys. */ }
    }
    if (!/^sb_publishable_[A-Za-z0-9_-]{10,250}$/.test(publicKey) && !publicRole) {
      throw new Error("Use a publishable or legacy anon key. Secret and service-role keys must never be used in the extension.");
    }
    return { url: url.origin, publicKey };
  }

  function start(browser, options = {}) {
    const fetcher = options.fetch || globalThis.fetch;
    const cryptoApi = options.crypto || globalThis.crypto;
    const withStorageLock = options.withStorageLock || ((callback) => callback());
    let operations = Promise.resolve();
    let generation = 0;
    const requests = new Set();
    let applying = false;
    let needsRecovery = true;

    const load = async () => (await browser.storage.local.get(STATE_KEY))[STATE_KEY] || {};
    const save = (state) => browser.storage.local.set({ [STATE_KEY]: state });
    const enqueue = (callback) => {
      const result = operations.catch(() => undefined).then(callback);
      operations = result.catch(() => undefined);
      return result;
    };
    const background = (callback) => enqueue(async () => {
      try { return await callback(); } catch (error) { await report(error); }
    });
    function cancel() {
      generation += 1;
      for (const controller of requests) controller.abort();
    }

    async function permitted(state) {
      if (!state.consent || !state.config) return false;
      if (!await browser.permissions.contains({ origins: [`${state.config.url}/*`] })) return false;
      const granted = await browser.permissions.getAll();
      // Firefox 140–147 / Android 142–147 use the explicit in-page consent.
      return !Object.hasOwn(granted, "data_collection") ||
        DATA_TYPES.every((type) => granted.data_collection.includes(type));
    }

    async function request(state, path, { method = "GET", body, token, headers = {} } = {}) {
      if (!await permitted(state)) throw new Error("Grant cloud sync permissions on the Sync page to continue.");
      const epoch = generation;
      const controller = new AbortController();
      requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetcher(`${state.config.url}${path}`, {
          method, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
          signal: controller.signal,
          headers: {
            apikey: state.config.publicKey, "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        // Bound both successful payloads and errors; never surface token-bearing server text.
        const reader = response.body && response.body.getReader();
        let text = "";
        let bytes = 0;
        const limit = path.startsWith("/rest/") ? Model.MAX_BYTES + 4096 : 65536;
        if (reader) {
          const decoder = new TextDecoder();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > limit) throw new Error("The cloud response exceeds the sync size limit.");
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        }
        if (epoch !== generation) throw new Error("Cloud sync stopped.");
        if (!response.ok) {
          const error = new Error(response.status === 401 ? "Your cloud session expired. Sign in again." :
            response.status === 404 ? "Cloud sync is not set up. Apply the Supabase database migration first." :
            response.status === 429 ? "Cloud sync is temporarily rate limited. It will retry later." :
            `Cloud request failed (${response.status}). Check the Supabase setup and try again.`);
          error.status = response.status;
          throw error;
        }
        return text ? JSON.parse(text) : null;
      } catch (error) {
        if (error.name === "AbortError") throw new Error("Cloud sync stopped or timed out. Local data is safe.");
        if (error instanceof SyntaxError) throw new Error("The cloud returned an invalid response.");
        if (error instanceof TypeError) throw new Error("Cloud sync could not connect. Check your connection and retry.");
        throw error;
      } finally {
        clearTimeout(timeout);
        requests.delete(controller);
      }
    }

    function sessionFrom(value) {
      if (!value || !UUID.test(value.user && value.user.id) ||
          typeof value.access_token !== "string" || value.access_token.length > 16384 || !value.access_token ||
          typeof value.refresh_token !== "string" || value.refresh_token.length > 16384 || !value.refresh_token ||
          !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
        throw new Error("Supabase returned an invalid sign-in session.");
      }
      return {
        accessToken: value.access_token, refreshToken: value.refresh_token,
        expiresAt: Date.now() + Math.min(value.expires_in, 86400) * 1000,
        userId: value.user.id,
        email: String(value.user.email || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 254)
      };
    }

    async function refresh(state) {
      const result = await request(state, "/auth/v1/token?grant_type=refresh_token", {
        method: "POST", body: { refresh_token: state.session.refreshToken }
      });
      const session = sessionFrom(result);
      if (session.userId !== state.owner.userId) throw new Error("The cloud account does not match this installation.");
      state.session = session;
      await save(state); // Persist rotated tokens before any further request.
    }

    async function api(state, path, options = {}) {
      if (state.session.expiresAt < Date.now() + 60000) await refresh(state);
      try {
        return await request(state, path, { ...options, token: state.session.accessToken });
      } catch (error) {
        if (error.status !== 401) throw error;
        await refresh(state);
        return request(state, path, { ...options, token: state.session.accessToken });
      }
    }

    async function recover() {
      if (!needsRecovery) return;
      const state = await load();
      if (!state.journal) {
        needsRecovery = false;
        return;
      }
      const target = Model.normalizeSnapshot(state.journal.target);
      const remote = Model.normalizeSnapshot(state.journal.remote);
      const stored = await browser.storage.local.get(null);
      const current = Model.toStorage(Model.snapshot(stored));
      const values = Model.toStorage(target);
      const remove = Object.keys(current).filter((key) => !Object.hasOwn(values, key));
      applying = true;
      try {
        if (remove.length) await browser.storage.local.remove(remove);
        await browser.storage.local.set({
          ...values,
          [STATE_KEY]: { ...state, base: remote, journal: null, lastSync: Date.now(), error: "" }
        });
        needsRecovery = false;
      } finally {
        applying = false;
      }
    }

    async function local(callback) {
      return withStorageLock(async () => {
        await recover();
        return callback();
      });
    }

    async function synchronize() {
      await local(() => undefined);
      const state = await load();
      if (!state.session || !state.consent) return;
      if (!state.owner || state.owner.userId !== state.session.userId || state.owner.project !== state.config.url) {
        throw new Error("The cloud account does not match this installation.");
      }
      const initial = await local(async () => Model.snapshot(await browser.storage.local.get(null)));
      const base = Model.normalizeSnapshot(state.base || {});
      const table = `/rest/v1/anydownload_sync?user_id=eq.${state.session.userId}`;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let rows = await api(state, `${table}&select=revision&limit=1`);
        if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid cloud sync record.");
        if (rows[0] && rows[0].revision !== state.revision) {
          rows = await api(state, `${table}&select=revision,payload&limit=1`);
          if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid cloud sync record.");
        }
        const row = rows[0];
        if (row && (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER)) {
          throw new Error("Invalid cloud sync revision.");
        }
        const remote = Model.normalizeSnapshot(row ? row.revision === state.revision ? base : row.payload : {});
        const merged = Model.merge(base, initial, remote);
        let revision = row ? row.revision : 1;
        if (!row || !Model.equal(merged, remote)) {
          try {
            const result = await api(state, row ? `${table}&revision=eq.${row.revision}&select=revision` : "/rest/v1/anydownload_sync?select=revision", {
              method: row ? "PATCH" : "POST",
              headers: { Prefer: "return=representation" },
              body: { ...(row ? {} : { user_id: state.session.userId }), revision: row ? row.revision + 1 : 1, payload: merged }
            });
            if (!Array.isArray(result) || result.length !== 1) continue;
            revision = row ? row.revision + 1 : 1;
          } catch (error) {
            if (error.status === 409) continue;
            throw error;
          }
        }
        await local(async () => {
          const latest = Model.snapshot(await browser.storage.local.get(null));
          // Retain edits made while the request was in flight. A durable journal
          // finishes interrupted multi-key writes before the next local mutation.
          const target = Model.merge(initial, latest, merged);
          needsRecovery = true;
          await save({ ...state, revision, journal: { target, remote: merged } });
          await recover();
          if (!Model.equal(target, merged)) scheduleChanges();
        });
        return;
      }
      throw new Error("Another device is updating your data. Sync will retry later.");
    }

    async function status() {
      const state = await load();
      const login = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      return {
        ok: true, configured: Boolean(state.config), config: state.config || { url: "", publicKey: "" },
        signedIn: Boolean(state.session), email: state.session && state.session.email || "",
        lastSync: state.lastSync || 0, error: state.error || "",
        pendingLogin: Boolean(login && login.expiresAt > Date.now()), accountBound: Boolean(state.owner)
      };
    }

    async function report(error) {
      const state = await load();
      state.error = error.message || "Cloud sync failed. Local data is safe.";
      await save(state);
    }
    const sync = () => background(synchronize);

    function scheduleChanges() {
      browser.alarms.create(CHANGE_ALARM, { when: Date.now() + 5000 });
    }

    async function signin() {
      const state = await load();
      if (!state.config || !await permitted(state)) throw new Error("Configure Supabase and allow cloud sync first.");
      if (state.session) throw new Error("You are already signed in.");
      const pending = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      if (pending && pending.expiresAt > Date.now()) throw new Error("Complete or cancel the current Google sign-in first.");
      const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
      const encode = (value) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const verifier = encode(bytes);
      const challenge = encode(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const nonce = encode(cryptoApi.getRandomValues(new Uint8Array(24)));
      const callback = `${state.config.url}${CALLBACK_PATH}?state=${nonce}`;
      const url = new URL(`${state.config.url}/auth/v1/authorize`);
      url.search = new URLSearchParams({
        provider: "google", redirect_to: callback, code_challenge: challenge,
        code_challenge_method: "s256", prompt: "select_account"
      }).toString();
      // Persist the tab ID before navigating: even an immediate redirect is bound
      // to the initiating tab and a verifier that never leaves this extension.
      const tab = await browser.tabs.create({ url: browser.runtime.getURL("sync/sync.html"), active: true });
      if (tab.incognito) {
        await browser.tabs.remove(tab.id);
        throw new Error("Sign in from a normal Firefox window.");
      }
      await browser.storage.session.set({ [LOGIN_KEY]: {
        tabId: tab.id, verifier, nonce, project: state.config.url, expiresAt: Date.now() + 10 * 60 * 1000
      } });
      await save({ ...state, error: "" });
      await browser.tabs.update(tab.id, { url: url.href });
    }

    async function callback(tabId, urlValue, tab) {
      const login = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      if (!login || login.tabId !== tabId || tab && tab.incognito) return;
      if (login.expiresAt <= Date.now()) {
        await browser.storage.session.remove(LOGIN_KEY);
        throw new Error("Sign-in expired. Try Google sign-in again.");
      }
      let url;
      try { url = new URL(urlValue); } catch (_error) { return; }
      if (url.origin !== login.project || url.pathname !== CALLBACK_PATH) return;
      if (url.searchParams.get("state") !== login.nonce) throw new Error("Sign-in callback could not be verified. Try again.");
      await browser.storage.session.remove(LOGIN_KEY);
      if (url.searchParams.has("error")) throw new Error("Google sign-in was cancelled or denied. Try again.");
      const code = url.searchParams.get("code");
      if (!code || code.length > 2048 || /[\s\u0000-\u001f]/.test(code)) throw new Error("The sign-in code is missing or invalid.");
      const state = await load();
      if (state.config.url !== login.project) throw new Error("The Supabase project changed during sign-in.");
      const result = await request(state, "/auth/v1/token?grant_type=pkce", {
        method: "POST", body: { auth_code: code, code_verifier: login.verifier }
      });
      const session = sessionFrom(result);
      const user = await request(state, "/auth/v1/user", { token: session.accessToken });
      if (!user || user.id !== session.userId) throw new Error("The Google account could not be verified.");
      if (state.owner && (state.owner.userId !== session.userId || state.owner.project !== login.project)) {
        throw new Error("Sign in with the same Google account previously linked to this installation.");
      }
      state.session = session;
      state.owner = { userId: session.userId, project: login.project };
      state.error = "";
      await save(state);
      await browser.tabs.update(tabId, { url: browser.runtime.getURL("sync/sync.html") });
      await synchronize();
    }

    function trusted(sender, syncPageOnly) {
      if (!sender || sender.id !== browser.runtime.id || sender.tab && sender.tab.incognito) return false;
      try {
        const url = new URL(sender.url);
        const base = new URL(browser.runtime.getURL("/"));
        return url.protocol === base.protocol && url.host === base.host &&
          (syncPageOnly ? url.pathname === "/sync/sync.html" :
            ["/popup/popup.html", "/sidebar/sidebar.html"].includes(url.pathname));
      } catch (_error) { return false; }
    }

    async function localWrite(message) {
      return local(async () => {
        if (message.action === "set") {
          const values = message.values;
          if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 10) {
            throw new Error("Invalid local settings update.");
          }
          // Device-only settings are accepted here but never added to a snapshot.
          const synced = { ...values };
          delete synced.destinationFolder;
          delete synced.askForSingle;
          if (Object.keys(synced).some((key) => !Model.SETTINGS_KEYS.includes(key) && !key.startsWith("ignoredImage:"))) {
            throw new Error("Invalid local settings key.");
          }
          Model.normalizeSnapshot(synced);
          if (Object.hasOwn(values, "destinationFolder") &&
              (!Core.validateFolderPath(values.destinationFolder).ok ||
               Core.validateFolderPath(values.destinationFolder).value !== values.destinationFolder)) throw new Error("Invalid folder.");
          if (Object.hasOwn(values, "askForSingle") && typeof values.askForSingle !== "boolean") throw new Error("Invalid Save As setting.");
          await browser.storage.local.set(values);
        } else if (message.action === "remove") {
          if (!Array.isArray(message.keys) || message.keys.length > 5000 || message.keys.some((key) => {
            if (typeof key !== "string" || !key.startsWith("ignoredImage:")) return true;
            try { Model.normalizeSnapshot({ [key]: 1 }); return false; } catch (_error) { return true; }
          })) throw new Error("Invalid ignored-media update.");
          await browser.storage.local.remove(message.keys);
        } else throw new Error("Unknown local settings action.");
        return { ok: true };
      });
    }

    browser.runtime.onMessage.addListener((message, sender) => {
      if (!message || !["CLOUD_SYNC", "CLOUD_LOCAL_WRITE"].includes(message.type)) return undefined;
      if (!trusted(sender, message.type === "CLOUD_SYNC")) return Promise.resolve({ ok: false, error: "Cloud sync is available only in normal extension pages." });
      if (message.type === "CLOUD_LOCAL_WRITE") return localWrite(message).catch((error) => ({ ok: false, error: error.message }));
      if (message.action === "status") return status();
      if (message.action === "signout" || message.action === "configure") cancel();
      return enqueue(async () => {
        try {
          if (message.action !== "signout") await local(() => undefined);
          let state = await load();
          if (message.action === "configure") {
            if (message.consent !== true) throw new Error("Choose whether to upload your data before enabling cloud sync.");
            const next = config(message.config);
            if (state.session) throw new Error("Sign out before changing the configuration.");
            if (state.owner && state.owner.project !== next.url) throw new Error("This installation is linked to a different Supabase project.");
            state = { ...state, config: next, consent: true, error: "" };
            if (!await permitted(state)) throw new Error("Grant the requested cloud sync permissions first.");
            await browser.storage.session.remove(LOGIN_KEY);
            await save(state);
          } else if (message.action === "signin") {
            await signin();
          } else if (message.action === "sync") {
            if (!state.session) throw new Error("Sign in with Google first.");
            await synchronize();
          } else if (message.action === "signout") {
            await browser.storage.session.remove(LOGIN_KEY);
            const old = state.session;
            state.session = null;
            state.error = "";
            await save(state);
            if (old && await permitted(state)) {
              await request(state, "/auth/v1/logout?scope=local", { method: "POST", token: old.accessToken }).catch(() => undefined);
            }
          } else {
            throw new Error("Unknown cloud sync action.");
          }
          return status();
        } catch (error) {
          await report(error);
          return { ...(await status()), ok: false, error: error.message };
        }
      });
    });

    browser.tabs.onUpdated.addListener((tabId, change, tab) => {
      if (!change.url || !change.url.includes(CALLBACK_PATH)) return;
      return background(() => callback(tabId, change.url, tab));
    });
    browser.tabs.onRemoved.addListener((tabId) => background(async () => {
      const login = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      if (login && login.tabId === tabId) await browser.storage.session.remove(LOGIN_KEY);
    }));
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || applying) return;
      if (Object.keys(changes).some((key) => Model.SETTINGS_KEYS.includes(key) || key.startsWith("ignoredImage:") || key === "downloadLedger:v1")) {
        scheduleChanges();
      }
    });
    browser.permissions.onRemoved.addListener(cancel);
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm && [ALARM, CHANGE_ALARM].includes(alarm.name)) return sync();
    });
    // ponytail: bounded snapshots every 15 minutes; use incremental rows if
    // real metadata/traffic approaches the 4 MiB snapshot ceiling.
    browser.alarms.create(ALARM, { periodInMinutes: 15 });
    const ready = background(async () => {
      await local(() => undefined);
      const login = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      if (login) {
        const tab = await browser.tabs.get(login.tabId).catch(() => null);
        if (tab) await callback(tab.id, tab.url, tab);
        else await browser.storage.session.remove(LOGIN_KEY);
      }
      const state = await load();
      if (state.session && Date.now() - (state.lastSync || 0) > 15 * 60 * 1000) await synchronize();
    });
    return { recover, ready };
  }

  return { start, config, STATE_KEY, LOGIN_KEY, DATA_TYPES };
});
