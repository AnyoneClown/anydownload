(() => {
  "use strict";

  const elements = {};
  let status = {};
  let busy = false;
  let activeAction = "";
  let refreshing = false;
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
    const syncing = Boolean(status.syncing) || busy && ["sync", "resume"].includes(activeAction);
    const permissionMissing = connected && status.permissionGranted === false;
    const badge = elements["status-badge"];
    badge.textContent = syncing ? "Syncing…" : busy ? "Please wait…" : pending ? "Awaiting Google"
      : !connected ? "Not connected" : permissionMissing ? "Permission needed" : paused ? "Paused"
      : status.error ? "Needs attention" : !status.lastSync ? "Getting ready" : "Auto-sync on";
    badge.setAttribute("data-tone", syncing || busy || pending ? "busy"
      : connected && (permissionMissing || status.error || paused) ? "warning" : connected ? "success" : "neutral");
    elements["account-heading"].textContent = connected ? "Connected with Google" : pending ? "Finish connecting" : "Connect with Google";
    elements["account-email"].textContent = connected ? status.email || "Google account" : "One sign-in to bring your setup along.";
    elements["account-avatar"].textContent = connected && status.email ? status.email[0].toUpperCase() : "G";
    elements["device-account"].textContent = connected && status.email || "the same Google account";
    elements["sync-status"].textContent = syncing ? "Merging your preferences and records with your other devices…"
      : busy ? activeAction === "signin" ? "Opening Google sign-in…" : "Updating your connection…"
      : permissionMissing ? "Allow Firefox permissions to reconnect. Your local data is safe."
      : connected && paused ? "Automatic sync is paused on this device. Your local changes stay here until you resume or sync now."
      : connected && status.error ? "The last sync did not finish. Your local data is safe; retry below."
      : connected ? "Local changes sync within seconds. Other-device changes are checked about once a minute."
      : pending ? "Finish Google sign-in in the opened tab. This page will update when you return."
      : "Cloud sync is off. Continue with Google to connect this device.";
    const timestamp = new Date(status.lastSync || 0);
    elements["last-sync"].hidden = !status.lastSync || !Number.isFinite(timestamp.getTime());
    elements["last-sync"].hidden = !connected || elements["last-sync"].hidden;
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 1000));
    elements["last-sync"].textContent = `Last successful sync: ${seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : timestamp.toLocaleString()}`;
    elements["last-sync"].title = timestamp.toLocaleString();
    elements["account-note"].hidden = !status.accountBound;
    elements["setup-section"].hidden = connected || pending;
    elements["automatic-section"].hidden = !connected;
    elements["auto-button"].disabled = !ready || busy || !connected;
    elements["auto-button"].setAttribute("aria-checked", String(!paused));
    elements["auto-label"].textContent = paused ? "Off" : "On";
    elements["auto-description"].textContent = paused ? "Resume to send and receive your latest changes." : "Runs in the background while Firefox is open.";
    elements["action-hint"].textContent = connected ? "Sync now checks both ways. Sign out disconnects only this device."
      : pending ? "You can cancel below if you don’t want to connect."
      : "Allow Firefox permissions, then choose your Google account in the tab that opens.";
    elements["sync-consent"].disabled = !ready || busy || connected || pending;
    elements["signin-button"].hidden = connected || pending;
    elements["signin-button"].disabled = !ready || busy || !status.config || !elements["sync-consent"].checked;
    elements["sync-button"].hidden = !connected;
    elements["sync-button"].disabled = !ready || busy || syncing || !connected;
    elements["sync-button"].textContent = syncing ? "Syncing…" : permissionMissing ? "Allow permissions & sync" : status.error ? "Retry sync" : "Sync now";
    elements["signout-button"].hidden = !connected && !pending;
    elements["signout-button"].textContent = pending ? "Cancel sign-in" : "Sign out";
    elements["signout-button"].disabled = !ready || busy;
    elements["refresh-button"].disabled = !ready || busy;
    elements["refresh-button"].hidden = connected || pending;
  }

  function applyStatus(response, initial = false) {
    if (initial || response.error !== status.error || response.lastSync !== status.lastSync || response.signedIn !== status.signedIn) showError(response.error);
    status = response;
    if (initial || status.signedIn) elements["sync-consent"].checked = Boolean(status.consent);
    render();
  }

  async function refresh(initial = false) {
    if (busy || refreshing) return;
    refreshing = true;
    try {
      const response = await browser.runtime.sendMessage({ type: "CLOUD_SYNC", action: "status" });
      if (busy) return;
      if (!response || !response.ok) {
        showError(response && response.error || "Firefox could not load cloud sync. Try refreshing the status.");
        return;
      }
      applyStatus(response, initial);
    } catch (_error) {
      showError("Firefox could not load cloud sync. Try refreshing the status.");
    } finally {
      refreshing = false;
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
    activeAction = action;
    render();
    try {
      if (!await permission) {
        showError("Permission was not granted. Cloud sync remains unchanged.");
        return;
      }
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
      activeAction = "";
      render();
    }
  }

  async function initialize() {
    for (const element of document.querySelectorAll("[id]")) elements[element.id] = element;
    const tab = await browser.tabs.getCurrent();
    if (browser.extension && browser.extension.inIncognitoContext || tab && tab.incognito) {
      elements["private-notice"].hidden = false;
      return;
    }
    const permissions = await browser.permissions.getAll();
    supportsDataConsent = Object.prototype.hasOwnProperty.call(permissions, "data_collection");
    elements["sync-card"].hidden = false;
    elements["sync-content"].hidden = false;
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
    initialize().catch(() => showError("Firefox could not open cloud sync. Reopen this page in a normal window."));
  }, { once: true });
})();
