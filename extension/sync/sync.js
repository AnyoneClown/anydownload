(() => {
  "use strict";

  const elements = {};
  let status = {};
  let busy = false;
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
    elements["account-heading"].textContent = connected ? "Your account" : "Connect your account";
    elements["sync-status"].textContent = busy ? "Updating cloud sync…"
      : connected ? `Signed in${status.email ? ` as ${status.email}` : ""}. Changes sync automatically.`
      : pending ? "Finish Google sign-in in the opened tab. This page will update when you return."
      : "Cloud sync is off. Continue with Google to connect this device.";
    const timestamp = new Date(status.lastSync || 0);
    elements["last-sync"].hidden = !status.lastSync || !Number.isFinite(timestamp.getTime());
    elements["last-sync"].textContent = `Last synced: ${timestamp.toLocaleString()}`;
    elements["account-note"].hidden = !status.accountBound;
    elements["sync-consent"].disabled = !ready || busy || connected || pending;
    elements["signin-button"].hidden = connected || pending;
    elements["signin-button"].disabled = !ready || busy || !status.config || !elements["sync-consent"].checked;
    elements["sync-button"].hidden = !connected;
    elements["sync-button"].disabled = !ready || busy || !connected;
    elements["signout-button"].hidden = !connected && !pending;
    elements["signout-button"].textContent = pending ? "Cancel sign-in" : "Sign out / stop sync";
    elements["signout-button"].disabled = !ready || busy;
    elements["refresh-button"].disabled = !ready || busy;
  }

  function applyStatus(response, initial = false) {
    status = response;
    if (initial) elements["sync-consent"].checked = Boolean(status.consent);
    render();
    showError(status.error);
  }

  async function refresh(initial = false) {
    if (busy) return;
    try {
      const response = await browser.runtime.sendMessage({ type: "CLOUD_SYNC", action: "status" });
      if (!response || !response.ok) {
        showError(response && response.error || "Firefox could not load cloud sync. Try refreshing the status.");
        return;
      }
      applyStatus(response, initial);
    } catch (_error) {
      showError("Firefox could not load cloud sync. Try refreshing the status.");
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
    if (["signin", "sync"].includes(action)) {
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
    elements["sync-consent"].addEventListener("change", render);
    for (const action of ["signin", "sync", "signout"]) {
      elements[`${action}-button`].addEventListener("click", () => act(action));
    }
    elements["refresh-button"].addEventListener("click", () => refresh());
    ready = true;
    await refresh(true);
    render();
    globalThis.addEventListener("focus", () => refresh());
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
