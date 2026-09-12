(() => {
  "use strict";

  const elements = {};
  let status = {};
  let busy = false;
  let ready = false;
  let configDirty = false;
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
    const locked = connected || pending;
    elements["account-heading"].textContent = connected ? "Your account" : "Connect your account";
    elements["sync-status"].textContent = busy ? "Updating cloud sync…"
      : connected ? `Signed in${status.email ? ` as ${status.email}` : ""}. Changes sync automatically.`
      : pending ? "Finish Google sign-in in the opened tab. This page will update when you return."
      : status.configured ? "Cloud sync is off. Continue with Google to connect this device."
      : "Save your Supabase project and continue with Google to enable sync.";
    const timestamp = new Date(status.lastSync || 0);
    elements["last-sync"].hidden = !status.lastSync || !Number.isFinite(timestamp.getTime());
    elements["last-sync"].textContent = `Last synced: ${timestamp.toLocaleString()}`;
    elements["account-note"].hidden = !status.accountBound;
    elements["project-url"].disabled = !ready || busy || locked || Boolean(status.accountBound);
    elements["public-key"].disabled = !ready || busy || locked;
    elements["sync-consent"].disabled = !ready || busy || connected || pending;
    elements["configure-button"].disabled = !ready || busy || locked || !elements["sync-consent"].checked;
    elements["signin-button"].hidden = connected || pending;
    elements["signin-button"].disabled = !ready || busy || !status.configured || configDirty || !elements["sync-consent"].checked;
    elements["sync-button"].hidden = !connected;
    elements["sync-button"].disabled = !ready || busy || !connected;
    elements["signout-button"].hidden = !connected && !pending;
    elements["signout-button"].textContent = pending ? "Cancel sign-in" : "Sign out / stop sync";
    elements["signout-button"].disabled = !ready || busy;
    elements["refresh-button"].disabled = !ready || busy;
  }

  function applyStatus(response, initial = false) {
    status = response;
    if (!configDirty) {
      elements["project-url"].value = status.config && status.config.url || "";
      elements["public-key"].value = status.config && status.config.publicKey || "";
    }
    if (initial) {
      elements["sync-consent"].checked = Boolean(status.configured);
      elements["project-details"].open = !status.configured;
    }
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
      throw new Error("Enter your HTTPS Supabase project URL, without a path or query.");
    }
    const permissions = { origins: [`${url.origin}/*`] };
    if (supportsDataConsent) permissions.data_collection = dataTypes;
    // Firefox requires this call to stay in the click/submit handler's direct stack.
    return browser.permissions.request(permissions);
  }

  async function act(action, config) {
    if (!ready || busy) return;
    showError("");
    let permission = Promise.resolve(true);
    if (["configure", "signin", "sync"].includes(action)) {
      if (!elements["sync-consent"].checked) {
        showError("Agree to cloud sync above before continuing.");
        return;
      }
      try {
        permission = permissionRequest(config || status.config);
      } catch (_error) {
        showError("Enter your HTTPS Supabase project URL, without a path or query, and allow access to continue.");
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
      const response = await browser.runtime.sendMessage({ type: "CLOUD_SYNC", action, config, consent: true });
      if (!response || !response.ok) {
        showError(response && response.error || "Cloud sync could not finish this request. Please try again.");
        return;
      }
      if (action === "configure") {
        configDirty = false;
        elements["project-details"].open = false;
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
    elements["config-form"].addEventListener("submit", (event) => {
      event.preventDefault();
      act("configure", {
        url: elements["project-url"].value.trim(),
        publicKey: elements["public-key"].value.trim()
      });
    });
    for (const id of ["project-url", "public-key"]) {
      elements[id].addEventListener("input", () => { configDirty = true; render(); });
    }
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
