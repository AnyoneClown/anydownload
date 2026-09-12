(() => {
  "use strict";
  const Immich = globalThis.ImageDownloaderImmich;
  const Integrations = globalThis.AnyDownloadIntegrations;
  const elements = {};
  let client;
  let account = {};
  let connections = [];
  let busy = false;
  let refreshing = false;
  let refreshPending = false;
  let revision = 0;
  let active;

  function error(message = "") {
    elements.error.textContent = message;
    elements.error.hidden = !message;
  }
  function selected() { return connections.find(value => value.id === elements.connections.value); }
  function render() {
    const saved = selected();
    const disabled = busy || !account.signedIn;
    for (const id of ["connections", "provider", "api-key", "save", "disconnect"]) elements[id].disabled = disabled;
    elements["server-url"].disabled = disabled || Boolean(saved);
    elements.disconnect.hidden = !saved;
    elements.cancel.hidden = !active;
    elements["form-title"].textContent = saved ? "Replace this server’s API key" : "Connect a server";
    elements.save.textContent = saved ? "Test & replace key" : "Test & save connection";
    elements.account.textContent = account.signedIn ? `Signed in as ${account.email || "your AnyDownload account"}.` : "Sign in to save and use external connections.";
  }
  function choose() {
    elements["api-key"].value = "";
    elements["server-url"].value = selected()?.serverUrl || "";
    error();
    render();
  }
  function clearKey() {
    elements["api-key"].value = "";
    if (active) {
      active.credential.apiKey = "";
      active.controller.abort();
    }
    client?.cancel();
  }
  async function refresh() {
    if (busy || refreshing) { refreshPending = true; return; }
    refreshing = true;
    const currentRevision = revision;
    try {
      const next = await client.status();
      const values = next.signedIn ? await client.list() : [];
      if (revision !== currentRevision) { refreshPending = true; return; }
      if (account.ownerId !== next.ownerId || account.signedIn !== next.signedIn) clearKey();
      account = next;
      const selectedId = elements.connections.value;
      connections = values;
      const options = [new Option("New Immich connection", ""), ...connections.map(value =>
        new Option(`Immich · ${value.serverUrl}`, value.id))];
      elements.connections.replaceChildren(...options);
      elements.connections.value = connections.some(value => value.id === selectedId) ? selectedId : "";
      render();
    } catch (_error) {
      error("Could not load connections. Sign in or restore permissions on the Sync page, then reopen Integrations.");
    } finally {
      refreshing = false;
      render();
      if (refreshPending && !busy) { refreshPending = false; await refresh(); }
    }
  }

  async function save(event) {
    event.preventDefault();
    if (busy || !account.signedIn) return;
    error();
    let credential;
    let permission;
    try {
      credential = { serverUrl: Immich.normalizeServerUrl(elements["server-url"].value), apiKey: elements["api-key"].value.trim() };
      if (!Integrations.validKey(credential.apiKey)) throw new Immich.ImmichError("invalid_key");
      // Keep the native permission request in the submit event's direct call stack.
      permission = browser.permissions.request({ origins: [Immich.permissionPattern(credential.serverUrl)] });
    } catch (failure) {
      if (credential) credential.apiKey = "";
      error(failure instanceof Immich.ImmichError ? Immich.errorMessage(failure.code) : "Firefox could not request server access. Try again.");
      return;
    }
    const saved = selected();
    const ownerId = account.ownerId;
    const operation = { credential, controller: new AbortController() };
    active = operation;
    busy = true;
    elements["api-key"].value = "";
    elements["server-url"].value = credential.serverUrl;
    elements.status.textContent = "Waiting for server permission…";
    render();
    try {
      if (!await permission) {
        elements.status.textContent = "";
        error("Server access was not granted. No connection was saved.");
        return;
      }
      const current = await client.status();
      if (!current.signedIn || current.ownerId !== ownerId || operation.controller.signal.aborted) return;
      elements.status.textContent = "Testing the API key on your Immich server…";
      const tested = await Immich.testConnection(credential, { signal: operation.controller.signal });
      if (operation.controller.signal.aborted) return;
      elements.status.textContent = "Connection verified. Saving the encrypted API key…";
      const result = await client.save({ provider: "immich", serverUrl: credential.serverUrl, apiKey: credential.apiKey,
        ...(saved ? { connectionId: saved.id, defaultAlbumId: saved.defaultAlbumId } : {}) });
      connections = [...connections.filter(value => value.id !== result.id), result];
      elements.connections.add(new Option(`Immich · ${result.serverUrl}`, result.id));
      elements.connections.value = result.id;
      elements.status.textContent = tested.canUseAlbums ? "Connection tested and saved. Library and album uploads are available."
        : "Connection tested and saved. Library uploads are available; add the album permissions to choose an album.";
    } catch (failure) {
      elements.status.textContent = "";
      error(failure instanceof Immich.ImmichError ? Immich.errorMessage(failure.code)
        : "The connection could not be saved. Check account sign-in and cloud permissions, then explicitly retry with the key.");
    } finally {
      operation.credential.apiKey = "";
      operation.controller.abort();
      active = null;
      busy = false;
      await refresh();
      render();
    }
  }

  async function disconnect() {
    const saved = selected();
    if (!saved || busy) return;
    clearKey();
    error();
    busy = true;
    render();
    try {
      await client.delete(saved.id);
      elements.connections.value = "";
      elements["server-url"].value = "";
      elements.status.textContent = "Connection and encrypted key deleted. Uploaded images remain in Immich.";
    } catch (_error) {
      error("The connection could not be deleted. Check your sign-in and retry; deletion has not been confirmed.");
    } finally { busy = false; await refresh(); }
  }

  async function initialize() {
    for (const element of document.querySelectorAll("[id]")) elements[element.id] = element;
    const tab = await browser.tabs.getCurrent();
    if (browser.extension?.inIncognitoContext || tab?.incognito) {
      elements["private-notice"].hidden = false;
      return;
    }
    client = Integrations.create(browser);
    elements.content.hidden = false;
    elements.connections.addEventListener("change", choose);
    elements["connection-form"].addEventListener("submit", save);
    elements.disconnect.addEventListener("click", disconnect);
    elements.cancel.addEventListener("click", () => { clearKey(); elements.status.textContent = "Cancelled. Re-enter the key to test again."; });
    const accountChanged = (changes, area) => {
      const change = changes["cloudSync:v1"];
      if (area === "local" && change && Integrations.identity(change.oldValue) !== Integrations.identity(change.newValue)) {
        revision += 1;
        clearKey();
        refresh();
      }
    };
    const changed = (value, sender) => {
      if (value?.type === "INTEGRATIONS_CHANGED" && sender?.id === browser.runtime.id) { revision += 1; clearKey(); refresh(); }
    };
    browser.storage.onChanged.addListener(accountChanged);
    browser.runtime.onMessage.addListener(changed);
    browser.permissions.onRemoved.addListener(clearKey);
    globalThis.addEventListener("focus", refresh);
    globalThis.addEventListener("pagehide", () => {
      clearKey();
      client.dispose();
      browser.storage.onChanged.removeListener(accountChanged);
      browser.runtime.onMessage.removeListener(changed);
      browser.permissions.onRemoved.removeListener(clearKey);
    }, { once: true });
    await refresh();
  }
  document.addEventListener("DOMContentLoaded", () => {
    initialize().catch(() => error("Firefox could not open Integrations. Reopen this page in a normal window."));
  }, { once: true });
})();
