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
  let loaded = false;
  let editing = false;
  let selectionInitialized = false;
  let errorSource = "";

  function error(message = "", source = "operation") {
    errorSource = message ? source : "";
    elements.error.textContent = message;
    elements.error.hidden = !message;
    elements["load-error-actions"].hidden = !message || source !== "refresh";
  }
  function selected() { return connections.find(value => value.id === elements.connections.value); }
  function shouldRestoreFocus(origin) {
    const current = document.activeElement;
    return !current || current === origin || current === document.body || current === document.documentElement ||
      current.disabled || current.hidden || Boolean(current.closest?.("[hidden]"));
  }
  function render() {
    const saved = selected();
    const signedIn = loaded && Boolean(account.signedIn);
    const disabled = busy || refreshing || !signedIn;
    elements["provider-overview"].hidden = signedIn && connections.length > 0;
    elements["provider-prerequisites"].hidden = signedIn;
    elements["upload-guide-title"].textContent = signedIn && connections.length ? "Upload to Immich" : "After connecting";
    elements["upload-guide-actions"].hidden = !signedIn || !connections.length;
    elements.content.hidden = !loaded;
    elements["signin-panel"].hidden = !loaded || signedIn;
    elements["connection-workspace"].hidden = !signedIn;
    elements["upload-link"].hidden = !signedIn || !connections.length;
    elements["saved-connections"].hidden = !signedIn || !connections.length;
    elements["connection-form"].hidden = !signedIn || Boolean(saved) && !editing;
    elements["server-field"].hidden = Boolean(saved);
    for (const id of ["connections", "api-key", "save", "disconnect", "replace-key-button", "add-server-button"]) elements[id].disabled = disabled;
    elements["add-server-button"].hidden = !saved;
    elements.connections.disabled = disabled || refreshing;
    elements["server-url"].disabled = disabled || Boolean(saved);
    elements.disconnect.hidden = !saved;
    elements["disconnect-section"].hidden = !saved;
    elements["replace-key-button"].hidden = editing;
    elements["replace-key-button"].setAttribute("aria-expanded", String(Boolean(saved) && editing));
    elements["cancel-edit"].hidden = !saved || !editing || Boolean(active);
    elements["cancel-edit"].disabled = busy || refreshing;
    elements.cancel.hidden = !active;
    elements["refresh-button"].disabled = busy || refreshing;
    elements["retry-load"].disabled = busy || refreshing;
    elements["refresh-button"].setAttribute("aria-busy", String(refreshing));
    elements["connection-form"].setAttribute("aria-busy", String(busy));
    elements["form-title"].textContent = saved ? "Replace API key" : "Connect server";
    elements.save.textContent = active ? "Testing…" : saved ? "Test & replace key" : "Test & save";
  }
  function choose() {
    if (busy || refreshing) return;
    elements["api-key"].value = "";
    elements["server-url"].value = selected()?.serverUrl || "";
    editing = false;
    error();
    elements.status.textContent = "";
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
    render();
    const currentRevision = revision;
    try {
      const next = await client.status();
      const values = next.signedIn ? await client.list() : [];
      if (revision !== currentRevision) { refreshPending = true; return; }
      const identityChanged = account.ownerId !== next.ownerId || account.signedIn !== next.signedIn;
      const previous = selected();
      const selectedId = elements.connections.value;
      if (identityChanged) {
        clearKey();
        selectionInitialized = false;
      }
      account = next;
      connections = values;
      const desiredId = !selectionInitialized ? connections[0]?.id || ""
        : connections.some(value => value.id === selectedId) ? selectedId : "";
      const options = [...connections.map(value => new Option(value.serverUrl, value.id)), new Option("Add server…", "")];
      elements.connections.replaceChildren(...options);
      elements.connections.value = desiredId;
      const current = selected();
      if (!selectionInitialized || selectedId !== desiredId || previous?.serverUrl !== current?.serverUrl) {
        clearKey();
        elements["server-url"].value = current?.serverUrl || "";
        editing = false;
      }
      selectionInitialized = true;
      loaded = true;
      if (errorSource === "refresh") error();
      render();
    } catch (_error) {
      error("Could not load connections. Refresh to retry, or check sign-in on Account.", "refresh");
    } finally {
      refreshing = false;
      elements["page-loading"].hidden = true;
      render();
      if (refreshPending && !busy) { refreshPending = false; await refresh(); }
    }
  }

  async function save(event) {
    event.preventDefault();
    if (busy || refreshing || !account.signedIn) return;
    const focusOrigin = document.activeElement;
    const restoreFocus = [elements.save, elements["api-key"]].includes(focusOrigin);
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
      elements.connections.add(new Option(result.serverUrl, result.id));
      elements.connections.value = result.id;
      editing = false;
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
      if (restoreFocus && loaded && shouldRestoreFocus(focusOrigin)) {
        const target = !account.signedIn ? elements["account-link"] :
          selected() && !editing ? elements["replace-key-button"] : elements["api-key"];
        if (!target.disabled && !target.hidden) target.focus({ preventScroll: true });
      }
    }
  }

  async function disconnect() {
    const saved = selected();
    if (!saved || busy || refreshing || !account.signedIn) return;
    const focusOrigin = document.activeElement;
    const restoreFocus = focusOrigin === elements.disconnect;
    clearKey();
    error();
    busy = true;
    elements.status.textContent = "Disconnecting your library…";
    render();
    try {
      await client.delete(saved.id);
      connections = connections.filter(value => value.id !== saved.id);
      elements.connections.value = "";
      editing = false;
      elements["server-url"].value = "";
      elements.status.textContent = "Connection and encrypted key deleted. Uploaded images remain in Immich.";
    } catch (_error) {
      elements.status.textContent = "";
      error("The connection could not be deleted. Check your sign-in and retry; deletion has not been confirmed.");
    } finally {
      busy = false;
      await refresh();
      if (restoreFocus && loaded && shouldRestoreFocus(focusOrigin)) {
        const target = !account.signedIn ? elements["account-link"] : selected() ? elements.disconnect : elements["server-url"];
        if (!target.disabled && !target.hidden) target.focus({ preventScroll: true });
      }
    }
  }

  async function initialize() {
    for (const element of document.querySelectorAll("[id]")) elements[element.id] = element;
    const tab = await browser.tabs.getCurrent();
    if (browser.extension?.inIncognitoContext || tab?.incognito) {
      elements["page-loading"].hidden = true;
      elements["private-notice"].hidden = false;
      elements["provider-prerequisites"].hidden = true;
      elements["page-actions"].hidden = true;
      elements["upload-guide"].hidden = true;
      return;
    }
    client = Integrations.create(browser);
    elements["refresh-button"].addEventListener("click", refresh);
    elements["retry-load"].addEventListener("click", async () => {
      if (busy || refreshing) return;
      const origin = document.activeElement;
      await refresh();
      if (origin === elements["retry-load"] && shouldRestoreFocus(origin)) {
        const target = !loaded ? elements["retry-load"] : !account.signedIn ? elements["account-link"] :
          selected() ? elements.connections : elements["server-url"];
        if (!target.disabled && !target.hidden) target.focus({ preventScroll: true });
      }
    });
    elements["add-server-button"].addEventListener("click", () => {
      if (busy || refreshing || !account.signedIn) return;
      elements.connections.value = "";
      choose();
      elements["server-url"].focus();
    });
    elements["replace-key-button"].addEventListener("click", () => {
      if (busy || refreshing || !account.signedIn || !selected()) return;
      editing = true;
      render();
      elements["api-key"].focus();
    });
    elements["cancel-edit"].addEventListener("click", () => {
      if (busy || refreshing) return;
      clearKey();
      editing = false;
      error();
      elements.status.textContent = "";
      render();
      elements["replace-key-button"].focus();
    });
    elements.connections.addEventListener("change", choose);
    elements["connection-form"].addEventListener("submit", save);
    elements.disconnect.addEventListener("click", disconnect);
    elements.cancel.addEventListener("click", () => { clearKey(); elements.status.textContent = "Cancelled. Re-enter the key to test again."; });
    const accountChanged = (changes, area) => {
      const change = changes["cloudSync:v1"];
      if (area === "local" && change && Integrations.identity(change.oldValue) !== Integrations.identity(change.newValue)) {
        revision += 1;
        clearKey();
        loaded = false;
        selectionInitialized = false;
        elements.status.textContent = "";
        elements["page-loading"].hidden = false;
        render();
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
    initialize().catch(() => {
      elements["page-loading"].hidden = true;
      error("Firefox could not open Integrations. Reopen this page in a normal window.");
    });
  }, { once: true });
})();
