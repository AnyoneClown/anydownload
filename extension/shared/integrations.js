(function attachIntegrations(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AnyDownloadIntegrations = api;
})(globalThis, function createIntegrations() {
  "use strict";

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const STATE_KEY = "cloudSync:v1";
  const STOPPED = "Integration access changed or the operation was cancelled. Reconnect and explicitly retry.";
  const FAILED = "The account connection request failed. Check your sign-in and retry.";

  function connection(value) {
    if (!value || !UUID.test(value.id) || value.provider !== "immich" ||
        typeof value.serverUrl !== "string" || value.serverUrl.length > 2048 ||
        value.defaultAlbumId != null && !UUID.test(value.defaultAlbumId)) throw new Error("Invalid saved connection.");
    let url;
    try { url = new URL(value.serverUrl); } catch (_error) { throw new Error("Invalid saved server URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value.serverUrl ||
        url.username || url.password) throw new Error("Invalid saved server URL.");
    return { id: value.id, provider: value.provider, serverUrl: url.origin, defaultAlbumId: value.defaultAlbumId || null };
  }

  function validKey(value) {
    return typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value);
  }

  function identity(state) {
    return JSON.stringify([state?.session?.userId || "", state?.owner?.userId || "",
      state?.owner?.project || "", state?.config?.url || "", Boolean(state?.consent)]);
  }

  function create(browser) {
    const active = new Set();
    let disposed = false;
    function cancel() {
      for (const operation of active) {
        if (operation.credential) operation.credential.apiKey = "";
        operation.controller.abort();
      }
    }
    const changed = (changes, area) => {
      const change = changes[STATE_KEY];
      if (area === "local" && change && identity(change.oldValue) !== identity(change.newValue)) cancel();
    };
    const message = (value, sender) => {
      if (value?.type === "INTEGRATIONS_CHANGED" && sender?.id === browser.runtime.id) cancel();
    };
    browser.storage.onChanged.addListener(changed);
    browser.permissions.onRemoved.addListener(cancel);
    browser.runtime.onMessage.addListener(message);

    async function call(action, values = {}) {
      if (disposed) throw new Error(STOPPED);
      const tab = await browser.tabs.getCurrent();
      if (browser.extension?.inIncognitoContext || tab?.incognito) throw new Error("Integrations are unavailable in private windows.");
      let response;
      try { response = await browser.runtime.sendMessage({ ...values, type: "INTEGRATIONS", action }); }
      catch (_error) { throw new Error(FAILED); }
      if (!response?.ok) {
        const messages = {
          signin: "Sign in to your AnyDownload account on the Account page first.",
          permission: "Restore cloud permissions on the Account page to use integrations.",
          missing: "This connection is no longer available. Refresh your connections.",
          invalid: "The connection details are invalid. Check the server URL and API key.",
          limit: "The account connection limit was reached. Disconnect an unused server first.",
          stopped: STOPPED
        };
        throw new Error(messages[response?.code] || FAILED);
      }
      return response;
    }

    async function withCredential(savedConnection, callback) {
      const saved = connection(savedConnection);
      const operation = { controller: new AbortController(), credential: null };
      active.add(operation);
      const check = () => { if (operation.controller.signal.aborted || disposed) throw new Error(STOPPED); };
      try {
        const before = await call("status");
        check();
        if (!before.signedIn || !UUID.test(before.ownerId)) throw new Error("Sign in on the Account page first.");
        const response = await call("credential", { connectionId: saved.id });
        const current = connection(response.connection);
        operation.credential = { serverUrl: current.serverUrl, apiKey: response.apiKey };
        response.apiKey = "";
        check();
        if (current.id !== saved.id || current.serverUrl !== saved.serverUrl || !validKey(operation.credential.apiKey)) {
          throw new Error("The saved connection changed. Select it again before retrying.");
        }
        const after = await call("status");
        check();
        if (!after.signedIn || before.ownerId !== after.ownerId || response.ownerId !== before.ownerId) throw new Error(STOPPED);
        const pattern = `${new URL(current.serverUrl).protocol}//${new URL(current.serverUrl).hostname}/*`;
        if (!await browser.permissions.contains({ origins: [pattern] })) throw new Error("Allow Firefox access to the configured Immich server before continuing.");
        check();
        const result = await callback(operation.credential, { signal: operation.controller.signal });
        check();
        return result;
      } finally {
        if (operation.credential) operation.credential.apiKey = "";
        operation.controller.abort();
        active.delete(operation);
      }
    }

    return {
      status: () => call("status"),
      async list() {
        const value = await call("list");
        if (!Array.isArray(value.connections) || value.connections.length > 20) throw new Error("Invalid saved connections.");
        return value.connections.map(connection);
      },
      async save(value) { cancel(); return connection((await call("save", value)).connection); },
      async delete(connectionId) { cancel(); await call("delete", { connectionId }); },
      async defaultAlbum(connectionId, defaultAlbumId) {
        return connection((await call("defaultAlbum", { connectionId, defaultAlbumId })).connection);
      },
      withCredential, cancel,
      dispose() {
        disposed = true;
        cancel();
        browser.storage.onChanged.removeListener(changed);
        browser.permissions.onRemoved.removeListener(cancel);
        browser.runtime.onMessage.removeListener(message);
      }
    };
  }

  return { create, connection, validKey, UUID, identity };
});
