(() => {
  "use strict";

  const elements = {};
  let status = {};
  let busy = false;
  let activeAction = "";
  let refreshing = false;
  let loaded = false;
  let loadFailed = false;
  let waitingPermission = false;
  let ready = false;
  let supportsDataConsent = false;
  const dataTypes = [
    "authenticationInfo", "personallyIdentifyingInfo", "browsingActivity", "websiteActivity", "websiteContent"
  ];

  function showError(message) {
    elements["error-banner"].textContent = message || "";
    elements["error-banner"].hidden = !message;
  }

  function render() {
    const connected = Boolean(status.signedIn);
    const pending = Boolean(status.pendingLogin);
    const paused = status.autoSync === false;
    const syncing = Boolean(status.syncing) || busy && !waitingPermission && ["sync", "resume"].includes(activeAction);
    const permissionMissing = connected && status.permissionGranted === false;
    const focused = document.activeElement;
    const badge = elements["status-badge"];
    badge.textContent = !loaded ? "Unavailable" : waitingPermission ? "Permission requested"
      : syncing ? "Syncing…" : busy ? activeAction === "signout" ? "Signing out…" : activeAction === "pause" ? "Pausing…" : "Connecting…"
      : pending ? "Sign-in pending" : !connected ? "Not connected"
      : permissionMissing ? "Permission needed" : paused ? "Paused"
      : status.error ? "Needs attention" : "Connected";
    badge.setAttribute("data-tone", waitingPermission || syncing || busy || pending ? "busy"
      : !loaded || connected && (permissionMissing || status.error || paused) ? "warning" : connected ? "success" : "neutral");
    elements["account-email"].textContent = connected ? status.email || "Google account" : "Cloud sync";
    elements["sync-purpose"].hidden = connected || pending || !loaded;
    const detail = waitingPermission ? "Allow Firefox permissions to continue."
      : pending ? "Finish Google sign-in in the opened tab."
      : permissionMissing ? "Allow Firefox permissions to resume sync."
      : connected && paused ? "Automatic sync is paused. Sync now still works."
      : "";
    if (elements["sync-status"].textContent !== detail) elements["sync-status"].textContent = detail;
    elements["sync-status"].hidden = !detail;
    const timestamp = new Date(status.lastSync || 0);
    const hasLastSync = Number(status.lastSync) > 0 && Number.isFinite(timestamp.getTime());
    const seconds = hasLastSync ? Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 1000)) : 0;
    elements["last-sync"].hidden = !connected;
    elements["last-sync"].textContent = hasLastSync
      ? `Last successful sync: ${seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : timestamp.toLocaleString()}`
      : "No successful sync yet.";
    elements["last-sync"].title = hasLastSync ? timestamp.toLocaleString() : "";
    elements["account-note"].hidden = !status.accountBound;
    elements["account-note"].textContent = connected
      ? "Signing out keeps local and cloud data. This installation stays linked to this Google account."
      : "This installation stays linked to your Google account. Use the same account to reconnect. Local and cloud data are kept.";
    elements["setup-section"].hidden = connected || pending || !loaded;
    elements["automatic-section"].hidden = !connected;
    elements["auto-button"].disabled = !ready || busy || !connected;
    elements["auto-button"].setAttribute("aria-checked", String(!paused));
    elements["auto-label"].textContent = paused ? "Off" : "On";
    elements["sync-consent"].disabled = !ready || busy || connected || pending || !loaded;
    elements["signin-button"].hidden = connected || pending || !loaded;
    elements["signin-button"].disabled = !ready || busy || !status.config || !elements["sync-consent"].checked;
    elements["sync-button"].hidden = !connected;
    elements["sync-button"].disabled = !ready || busy || syncing || !connected;
    elements["sync-button"].textContent = syncing ? "Syncing…" : permissionMissing ? "Allow permissions & sync" : status.error ? "Retry sync" : "Sync now";
    elements["signout-button"].hidden = !connected && !pending;
    elements["signout-button"].textContent = pending ? "Cancel sign-in" : "Sign out";
    elements["signout-button"].disabled = !ready || busy;
    elements["refresh-button"].disabled = !ready || busy || refreshing;
    elements["refresh-button"].hidden = !loadFailed;
    const focusHidden = focused && (focused.hidden ||
      focused.id === "sync-consent" && elements["setup-section"].hidden ||
      focused.id === "auto-button" && elements["automatic-section"].hidden);
    if (focusHidden && typeof elements["sync-card"].focus === "function") {
      elements["sync-card"].focus({ preventScroll: true });
    }
  }

  function applyStatus(response, initial = false) {
    if (initial || loadFailed || response.error !== status.error || response.lastSync !== status.lastSync || response.signedIn !== status.signedIn) showError(response.error);
    status = response;
    loaded = true;
    loadFailed = false;
    if (initial || status.signedIn) elements["sync-consent"].checked = Boolean(status.consent);
    render();
  }

  async function refresh(initial = false) {
    if (busy || refreshing) return;
    refreshing = true;
    elements["refresh-button"].disabled = true;
    elements["refresh-button"].setAttribute("aria-busy", "true");
    try {
      const response = await browser.runtime.sendMessage({ type: "CLOUD_SYNC", action: "status" });
      if (busy) return;
      if (!response || !response.ok) {
        loadFailed = true;
        showError(response && response.error || "Firefox could not load cloud sync. Refresh to try again.");
        return;
      }
      applyStatus(response, initial);
    } catch (_error) {
      loadFailed = true;
      showError("Firefox could not load cloud sync. Refresh to try again.");
    } finally {
      refreshing = false;
      elements["refresh-button"].setAttribute("aria-busy", "false");
      elements["page-loading"].hidden = true;
      elements["sync-card"].hidden = false;
      elements["sync-content"].hidden = false;
      render();
    }
  }

  function permissionRequest(config) {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Cloud sync configuration is unavailable.");
    }
    const permissions = { origins: [`${url.origin}/*`] };
    if (supportsDataConsent) permissions.data_collection = dataTypes;
    // Firefox requires this call to stay in the click handler's direct stack.
    return browser.permissions.request(permissions);
  }

  async function act(action) {
    if (!ready || busy) return;
    showError("");
    let permission = Promise.resolve(true);
    if (["signin", "sync", "resume"].includes(action)) {
      if (!elements["sync-consent"].checked) {
        showError("Agree to cloud sync above before continuing.");
        return;
      }
      try {
        permission = permissionRequest(status.config);
      } catch (_error) {
        showError("Cloud sync could not request permission. Refresh this page and try again.");
        return;
      }
    }
    busy = true;
    waitingPermission = ["signin", "sync", "resume"].includes(action);
    activeAction = action;
    render();
    try {
      if (!await permission) {
        showError("Permission was not granted. Cloud sync remains unchanged.");
        return;
      }
      waitingPermission = false;
      render();
      const response = await browser.runtime.sendMessage({ type: "CLOUD_SYNC", action, consent: true });
      if (!response || !response.ok) {
        showError(response && response.error || "Cloud sync could not finish this request. Please try again.");
        return;
      }
      applyStatus(response);
    } catch (_error) {
      showError("Cloud sync could not finish this request. Please try again.");
    } finally {
      busy = false;
      waitingPermission = false;
      activeAction = "";
      render();
    }
  }

  async function initialize() {
    for (const element of document.querySelectorAll("[id]")) elements[element.id] = element;
    const tab = await browser.tabs.getCurrent();
    if (browser.extension && browser.extension.inIncognitoContext || tab && tab.incognito) {
      elements["page-loading"].hidden = true;
      elements["private-notice"].hidden = false;
      return;
    }
    const permissions = await browser.permissions.getAll();
    supportsDataConsent = Object.prototype.hasOwnProperty.call(permissions, "data_collection");
    elements["sync-consent"].addEventListener("change", render);
    for (const action of ["signin", "sync", "signout"]) {
      elements[`${action}-button`].addEventListener("click", () => act(action));
    }
    elements["refresh-button"].addEventListener("click", () => refresh());
    elements["auto-button"].addEventListener("click", () => act(status.autoSync === false ? "resume" : "pause"));
    ready = true;
    await refresh(true);
    render();
    globalThis.addEventListener("focus", () => refresh());
    const timer = globalThis.setInterval(() => { if (!document.hidden) refresh(); }, 3000);
    globalThis.addEventListener("pagehide", () => globalThis.clearInterval(timer), { once: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && Object.keys(changes).some((key) => key.startsWith("cloudSync")) ||
        area === "session" && Object.keys(changes).some((key) => key.startsWith("cloudLogin"))) refresh();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initialize().catch(() => {
      elements["page-loading"].hidden = true;
      showError("Firefox could not open cloud sync. Reopen this page in a normal window.");
    });
  }, { once: true });
})();
