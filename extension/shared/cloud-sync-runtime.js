(function attachCloudRuntime(root, factory) {
  "use strict";
  const api = factory(root.AnyDownloadCloudSync, root.ImageDownloaderCore, root.AnyDownloadIntegrations);
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./cloud-sync.js"), require("./core.js"), require("./integrations.js"));
  } else {
    root.AnyDownloadCloudRuntime = api;
  }
})(globalThis, function createCloudRuntime(Model, Core, Integrations) {
  "use strict";

  const STATE_KEY = "cloudSync:v1";
  const LOGIN_KEY = "cloudLogin:v1";
  const ALARM = "anydownload-cloud-sync";
  const CHANGE_ALARM = `${ALARM}-changes`;
  const SYNC_MINUTES = 1;
  const DATA_TYPES = ["authenticationInfo", "personallyIdentifyingInfo", "browsingActivity", "websiteActivity", "websiteContent"];
  const CALLBACK_PATH = "/functions/v1/sync-callback";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CONFIG = Object.freeze({
    url: "https://ingepnogawhwgwakgpao.supabase.co",
    publicKey: "sb_publishable_b4-FtAiz2t0qy4XnHHLVxQ_I_ZlTxRk"
  });

  function start(browser, options = {}) {
    const fetcher = options.fetch || globalThis.fetch;
    const cryptoApi = options.crypto || globalThis.crypto;
    const withStorageLock = options.withStorageLock || ((callback) => callback());
    let operations = Promise.resolve();
    let generation = 0;
    let integrationGeneration = 0;
    const requests = new Set();
    let applying = false;
    let needsRecovery = true;
    let syncing = false;
    let autoSyncQueued = false;

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

    function invalidateIntegrations() {
      integrationGeneration += 1;
      browser.runtime.sendMessage?.({ type: "INTEGRATIONS_CHANGED" }).catch(() => undefined);
    }

    async function permitted(state) {
      if (!state.consent || state.config?.url !== CONFIG.url) return false;
      if (!await browser.permissions.contains({ origins: [`${CONFIG.url}/*`] })) return false;
      const granted = await browser.permissions.getAll();
      // Firefox 140–147 / Android 142–147 use the explicit in-page consent.
      return !Object.hasOwn(granted, "data_collection") ||
        DATA_TYPES.every((type) => granted.data_collection.includes(type));
    }

    async function request(state, path, { method = "GET", body, token, headers = {} } = {}) {
      if (!await permitted(state)) throw new Error("Grant cloud sync permissions on the Account page to continue.");
      const epoch = generation;
      const controller = new AbortController();
      requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetcher(`${CONFIG.url}${path}`, {
          method, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
          signal: controller.signal,
          headers: {
            apikey: CONFIG.publicKey, "Content-Type": "application/json",
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
            response.status === 404 ? "Cloud sync is temporarily unavailable. Try again later." :
            response.status === 429 ? "Cloud sync is temporarily rate limited. It will retry later." :
            `Cloud request failed (${response.status}). Please try again.`);
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

    async function synchronize(automatic = false) {
      const state = await load();
      if (automatic && state.autoSync === false) return;
      syncing = true;
      try { await exchange(); } finally { syncing = false; }
    }

    async function exchange() {
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
          if (!Model.equal(target, merged)) await scheduleChanges();
        });
        return;
      }
      throw new Error("Another device is updating your data. Sync will retry later.");
    }

    async function status() {
      const state = await load();
      const login = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      return {
        ok: true, configured: true, config: CONFIG, consent: Boolean(state.consent),
        signedIn: Boolean(state.session), email: state.session && state.session.email || "",
        lastSync: state.lastSync || 0, error: state.error || "",
        syncing, autoSync: state.autoSync !== false,
        permissionGranted: await permitted(state),
        pendingLogin: Boolean(login && login.expiresAt > Date.now()), accountBound: Boolean(state.owner)
      };
    }

    async function report(error) {
      const state = await load();
      state.error = error.message || "Cloud sync failed. Local data is safe.";
      await save(state);
    }
    const sync = () => {
      if (autoSyncQueued) return operations;
      autoSyncQueued = true;
      return background(async () => {
        try { await synchronize(true); } finally { autoSyncQueued = false; }
      });
    };

    async function scheduleChanges() {
      const state = await load();
      if (state.session && state.consent && state.autoSync !== false) {
        await browser.alarms.create(CHANGE_ALARM, { when: Date.now() + 5000 });
      }
    }

    async function schedule(state) {
      await browser.alarms.clear(CHANGE_ALARM);
      if (state.session && state.consent && state.autoSync !== false) {
        await browser.alarms.create(ALARM, { periodInMinutes: SYNC_MINUTES });
      } else {
        await browser.alarms.clear(ALARM);
      }
    }

    async function signin(consent) {
      const state = await load();
      if (consent !== true) throw new Error("Choose whether to upload your data before enabling cloud sync.");
      state.consent = true;
      if (!await permitted(state)) throw new Error("Allow cloud sync permissions first.");
      if (state.session) throw new Error("You are already signed in.");
      const pending = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      if (pending && pending.expiresAt > Date.now()) throw new Error("Complete or cancel the current Google sign-in first.");
      const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
      const encode = (value) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const verifier = encode(bytes);
      const challenge = encode(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const nonce = encode(cryptoApi.getRandomValues(new Uint8Array(24)));
      const callback = `${CONFIG.url}${CALLBACK_PATH}?state=${nonce}`;
      const url = new URL(`${CONFIG.url}/auth/v1/authorize`);
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
        tabId: tab.id, verifier, nonce, project: CONFIG.url, expiresAt: Date.now() + 10 * 60 * 1000
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
      if (login.project !== CONFIG.url || url.origin !== login.project || url.pathname !== CALLBACK_PATH) return;
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
      state.autoSync = true;
      state.owner = { userId: session.userId, project: login.project };
      state.error = "";
      await save(state);
      await schedule(state);
      await browser.tabs.update(tabId, { url: browser.runtime.getURL("sync/sync.html") });
      await synchronize();
    }

    function trusted(sender, syncPageOnly) {
      if (!sender || sender.id !== browser.runtime.id || sender.tab && sender.tab.incognito) return false;
      try {
        const url = new URL(sender.url);
        const base = new URL(browser.runtime.getURL("/"));
        return url.protocol === base.protocol && url.host === base.host &&
          (Array.isArray(syncPageOnly) ? syncPageOnly.includes(url.pathname) : syncPageOnly ? url.pathname === "/sync/sync.html" :
            ["/popup/popup.html", "/sidebar/sidebar.html"].includes(url.pathname));
      } catch (_error) { return false; }
    }

    async function integrationStatus() {
      const state = await load();
      const signedIn = Boolean(state.consent && state.session && state.owner &&
        UUID.test(state.session.userId) && state.session.userId === state.owner.userId &&
        state.config?.url === CONFIG.url && state.owner.project === CONFIG.url);
      return { ok: true, signedIn, ownerId: signedIn ? state.session.userId : "", email: signedIn ? state.session.email || "" : "" };
    }

    async function integrationRequest(message, epoch) {
      if (epoch !== integrationGeneration) return { ok: false, code: "stopped" };
      let payload;
      try {
        const state = await load();
        const current = await integrationStatus();
        if (!current.signedIn) return { ok: false, code: "signin" };
        if (!await permitted(state)) return { ok: false, code: "permission" };
        const { action } = message;
        const fields = ["type", "action"];
        const body = { action };
        if (["save", "credential", "delete", "defaultAlbum"].includes(action)) {
          fields.push("connectionId");
          if (message.connectionId !== undefined || action !== "save") {
            if (!UUID.test(message.connectionId)) return { ok: false, code: "invalid" };
            body.connectionId = message.connectionId;
          }
        }
        if (action === "save") {
          fields.push("provider", "serverUrl", "apiKey", "defaultAlbumId");
          const normalized = Integrations.connection({ id: message.connectionId || "00000000-0000-0000-0000-000000000000",
            provider: message.provider, serverUrl: message.serverUrl, defaultAlbumId: message.defaultAlbumId });
          if (!Integrations.validKey(message.apiKey)) return { ok: false, code: "invalid" };
          Object.assign(body, { provider: normalized.provider, serverUrl: normalized.serverUrl, apiKey: message.apiKey });
          if (Object.hasOwn(message, "defaultAlbumId")) body.defaultAlbumId = normalized.defaultAlbumId;
        } else if (action === "defaultAlbum") {
          fields.push("defaultAlbumId");
          if (message.defaultAlbumId !== null && !UUID.test(message.defaultAlbumId)) return { ok: false, code: "invalid" };
          body.defaultAlbumId = message.defaultAlbumId;
        } else if (!["list", "credential", "delete"].includes(action)) return { ok: false, code: "invalid" };
        if (Object.keys(message).some(key => !fields.includes(key))) return { ok: false, code: "invalid" };
        if (epoch !== integrationGeneration) return { ok: false, code: "stopped" };
        try { payload = await api(state, "/functions/v1/external-integrations", { method: "POST", body }); }
        finally { if (body.apiKey) body.apiKey = ""; }
        const latest = await load();
        if (epoch !== integrationGeneration || Integrations.identity(state) !== Integrations.identity(latest) || !await permitted(latest)) {
          return { ok: false, code: "stopped" };
        }
        if (action === "list") {
          if (!Array.isArray(payload?.connections) || payload.connections.length > 20) return { ok: false, code: "invalid" };
          return { ok: true, connections: payload.connections.map(Integrations.connection) };
        }
        if (action === "delete") return payload?.deleted === true ? { ok: true, deleted: true } : { ok: false, code: "invalid" };
        const result = Integrations.connection(payload?.connection);
        if (body.connectionId && result.id !== body.connectionId) return { ok: false, code: "invalid" };
        if (action !== "credential") return { ok: true, connection: result };
        if (!Integrations.validKey(payload.apiKey)) return { ok: false, code: "invalid" };
        return { ok: true, connection: result, apiKey: payload.apiKey, ownerId: current.ownerId };
      } catch (error) {
        // Credential operations never call report(): no server text or key reaches durable sync errors.
        return { ok: false, code: error.status === 401 ? "signin" : error.status === 404 ? "missing" :
          error.status === 400 ? "invalid" : error.status === 409 ? "limit" : "failed" };
      } finally {
        if (payload && Object.hasOwn(payload, "apiKey")) payload.apiKey = "";
      }
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
      if (!message || !["CLOUD_SYNC", "CLOUD_LOCAL_WRITE", "INTEGRATIONS"].includes(message.type)) return undefined;
      if (message.type === "INTEGRATIONS") {
        const pages = ["/integrations/integrations.html"];
        if (["status", "list", "credential", "defaultAlbum"].includes(message.action)) pages.push("/upload/upload.html");
        if (["status", "list"].includes(message.action)) pages.push("/popup/popup.html", "/sidebar/sidebar.html");
        if (!trusted(sender, pages)) return Promise.resolve({ ok: false, code: "private" });
        if (message.action === "status") return ready.then(integrationStatus);
        if (["save", "delete"].includes(message.action)) invalidateIntegrations();
        const epoch = integrationGeneration;
        return enqueue(() => integrationRequest(message, epoch));
      }
      if (!trusted(sender, message.type === "CLOUD_SYNC")) return Promise.resolve({ ok: false, error: "Cloud sync is available only in normal extension pages." });
      if (message.type === "CLOUD_LOCAL_WRITE") return localWrite(message).catch((error) => ({ ok: false, error: error.message }));
      if (message.action === "status") return ready.then(status);
      if (["signout", "pause"].includes(message.action)) cancel();
      if (message.action === "signout") invalidateIntegrations();
      return enqueue(async () => {
        try {
          if (message.action !== "signout") await local(() => undefined);
          let state = await load();
          if (message.action === "signin") {
            await signin(message.consent);
          } else if (message.action === "sync") {
            if (!state.session) throw new Error("Sign in with Google first.");
            await synchronize();
          } else if (["pause", "resume"].includes(message.action)) {
            if (!state.session) throw new Error("Sign in with Google first.");
            state.autoSync = message.action === "resume";
            state.error = "";
            await save(state);
            await schedule(state);
            if (state.autoSync) await synchronize();
          } else if (message.action === "signout") {
            await browser.storage.session.remove(LOGIN_KEY);
            const old = state.session;
            state.session = null;
            state.error = "";
            await save(state);
            await schedule(state);
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
      if (area !== "local") return;
      const account = changes[STATE_KEY];
      if (account && Integrations.identity(account.oldValue) !== Integrations.identity(account.newValue)) {
        cancel();
        invalidateIntegrations();
      }
      if (applying) return;
      if (Object.keys(changes).some((key) => Model.SETTINGS_KEYS.includes(key) || key.startsWith("ignoredImage:") || key === "downloadLedger:v1")) {
        return scheduleChanges().catch(() => undefined);
      }
    });
    browser.permissions.onRemoved.addListener(() => { cancel(); invalidateIntegrations(); });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm && [ALARM, CHANGE_ALARM].includes(alarm.name)) return sync();
    });
    // ponytail: poll revisions once a minute; use push if sub-minute delivery is needed.
    globalThis.addEventListener?.("online", sync);
    const ready = background(async () => {
      await local(async () => {
        const state = await load();
        if (state.config && state.config.url !== CONFIG.url || state.owner && state.owner.project !== CONFIG.url) {
          // Recover local writes before discarding another project's tokens and merge history.
          await browser.storage.session.remove(LOGIN_KEY);
          await save({ config: CONFIG, consent: false,
            error: "Cloud sync now uses AnyDownload's shared service. Review consent and sign in again to sync this device's local data." });
        } else if (state.config?.publicKey !== CONFIG.publicKey) {
          await save({ ...state, config: CONFIG });
        }
      });
      const login = (await browser.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
      if (login) {
        const tab = await browser.tabs.get(login.tabId).catch(() => null);
        if (tab) await callback(tab.id, tab.url, tab);
        else await browser.storage.session.remove(LOGIN_KEY);
      }
      const state = await load();
      await schedule(state);
      if (state.session && Date.now() - (state.lastSync || 0) > SYNC_MINUTES * 60 * 1000) await synchronize(true);
    });
    return { recover, ready };
  }

  return { start, CONFIG, STATE_KEY, LOGIN_KEY, DATA_TYPES };
});
