(function attachUploadPage(root) {
  "use strict";
  const Core = root.ImageDownloaderCore || (typeof module === "object" ? require("../shared/core.js") : null);
  const Uploads = root.ImageDownloaderUploads || (typeof module === "object" ? require("../shared/uploads.js") : null);
  const STORE_KEY = "externalUploads:v1";
  const MAX_JOBS = 20;
  const MAX_BYTES = 4 * 1024 * 1024;
  const ID = /^[a-z0-9-]{8,80}$/i;

  function createStore(browser, locks) {
    const read = async () => {
      const stored = (await browser.storage.local.get(STORE_KEY))[STORE_KEY];
      if (stored === undefined) return [];
      if (!Array.isArray(stored) || stored.length > MAX_JOBS) throw new Error("Saved upload records are invalid.");
      return stored;
    };
    async function write(change) {
      return locks.request(STORE_KEY, async () => {
        const jobs = change(await read());
        // ponytail: one bounded record; split by job if checkpoint writes become slow.
        if (jobs.length > MAX_JOBS || new TextEncoder().encode(JSON.stringify(jobs)).length > MAX_BYTES) {
          throw new Error("Upload history is full. Remove an old upload record before starting another.");
        }
        await browser.storage.local.set({ [STORE_KEY]: jobs });
      });
    }
    return {
      list: async (ownerId) => (await read()).filter((job) => job.ownerId === ownerId),
      save: (job) => write((jobs) => [...jobs.filter((item) => item.id !== job.id), job]),
      remove: (id, ownerId) => write((jobs) => jobs.filter((job) => job.id !== id || job.ownerId !== ownerId))
    };
  }

  function validateRequest(value) {
    if (!value || value.incognito !== false || !Number.isFinite(value.createdAt) ||
        Date.now() - value.createdAt > 600000 || value.createdAt > Date.now() + 60000 ||
        !Array.isArray(value.items) || !value.items.length || value.items.length > 500) {
      throw new Error("The selected-image request expired or is invalid. Select the images again.");
    }
    return value.items;
  }

  async function initialize(options = {}) {
    const browser = options.browser || root.browser;
    const document = options.document || root.document;
    const location = options.location || root.location;
    const workspace = options.workspace || root.parent?.AnyDownloadWorkspace;
    const locks = options.locks || root.navigator.locks;
    const elements = {};
    for (const element of document.querySelectorAll("[id]")) elements[element.id] = element;
    const tab = await browser.tabs.getCurrent();
    if (browser.extension?.inIncognitoContext || tab?.incognito) {
      elements["private-notice"].hidden = false;
      elements["account-status"].textContent = "Private window";
      return;
    }
    if (!locks) throw new Error("Firefox could not acquire upload locks. Reopen this page in a normal window.");
    const client = options.client || root.AnyDownloadIntegrations.create(browser);
    const provider = options.provider || root.ImageDownloaderImmich;
    const imageFetch = options.imageFetch || root.ImageDownloaderImageFetch;
    const store = createStore(browser, locks);
    let account = await client.status();
    let connections = [];
    let items = [];
    let files = [];
    let job = null;
    let busy = false;
    let actionController = null;
    let epoch = 0;
    let refreshGeneration = 0;
    let destinationId = "";
    let destinationJobId = null;
    let inputRestored = false;
    let restoring = null;
    const params = new URL(location.href).searchParams;

    function error(message = "") {
      elements["error-banner"].textContent = message;
      elements["error-banner"].hidden = !message;
    }
    function preserveTransfer(event, link) {
      if (busy) {
        event.preventDefault();
        browser.tabs.create({ url: link.href, active: true }).catch(() => error("Firefox could not open that page."));
        return;
      }
      const page = new URL(location.href);
      const target = new URL(link.href, page);
      if (page.searchParams.get("embedded") === "1" && workspace &&
          target.protocol === page.protocol && target.host === page.host && target.pathname === "/upload/upload.html") {
        event.preventDefault();
        workspace.open("upload", target.search);
      }
    }
    const selectedConnection = () => connections.find((entry) => entry.id === elements["connection-select"].value);
    function render() {
      elements["account-status"].textContent = account.signedIn ? `Signed in as ${account.email || "your AnyDownload account"}` : "Sign in on the Account page to connect a destination and upload.";
      elements["upload-content"].hidden = !account.signedIn;
      elements["signin-card"].hidden = account.signedIn;
      elements["connection-select"].disabled = busy || Boolean(job) || !connections.length;
      elements["album-select"].disabled = busy || Boolean(job) || !selectedConnection();
      elements["albums-button"].disabled = busy || Boolean(job) || !selectedConnection();
      elements["local-files"].disabled = busy;
      elements["start-button"].hidden = Boolean(job);
      elements["start-button"].disabled = busy || !selectedConnection() || !items.length;
      elements["retry-button"].hidden = !job || job.status === "complete";
      elements["retry-button"].textContent = busy ? "Uploading…" : "Retry unfinished images";
      elements["retry-button"].disabled = busy || !selectedConnection() || Boolean(job &&
        (job.connectionId !== selectedConnection()?.id || job.serverUrl !== selectedConnection()?.serverUrl));
      elements["cancel-button"].disabled = !busy;
      const imageCount = job ? job.items.length : items.length;
      elements["selection-count"].textContent = `${imageCount} image${imageCount === 1 ? "" : "s"}`;
      elements["selection-note"].textContent = job
        ? job.status === "complete" ? "All images uploaded. Choose New upload to send more." : "To retry local images after reopening, choose the original files again."
        : items.length ? "Ready to upload. Choosing local files replaces this selection." : "Select up to 500 images for one upload.";
      if (busy && job && job.status !== "complete") {
        elements["selection-note"].textContent = `Uploading ${imageCount} image${imageCount === 1 ? "" : "s"}. Keep this view open.`;
      }
      elements["progress-empty"].hidden = Boolean(job);
      elements["progress-panel"].dataset.state = job?.status || "ready";
      if (!job) {
        elements["progress-heading"].textContent = "Ready when you are";
        elements["progress-summary"].textContent = "No upload started.";
        elements["upload-progress"].max = 1;
        elements["upload-progress"].value = 0;
        elements["results-list"].replaceChildren();
        return;
      }
      const complete = job.items.filter((item) => item.assetId && (item.albumStatus === "none" || item.albumStatus === "complete")).length;
      elements["progress-heading"].textContent = job.status === "complete" ? "Upload complete" : busy ? "Uploading…" : "Ready to retry";
      elements["upload-progress"].max = job.items.length;
      elements["upload-progress"].value = complete;
      elements["progress-summary"].textContent = `${complete} of ${job.items.length} images complete${complete < job.items.length ? ` · ${job.items.length - complete} unfinished` : ""}.`;
      const rows = job.items.map((item) => {
        const row = document.createElement("li");
        const title = document.createElement("strong");
        title.textContent = item.filename;
        const detail = document.createElement("span");
        const asset = item.assetId ? item.duplicate ? "Already in Immich" : "Uploaded to Immich" : {
          pending: "Waiting to upload", fetching: "Reading image…", uploading: "Uploading…",
          failed: "Upload failed", uncertain: "Upload needs confirmation", cancelled: "Cancelled"
        }[item.uploadStatus];
        const album = item.assetId && job.albumId ? {
          pending: "Album step pending", attaching: "Adding to album…", complete: "Added to album", failed: "Album step failed"
        }[item.albumStatus] : "";
        detail.textContent = `${asset}${album ? ` · ${album}` : ""}${item.errorCode ? ` — ${Uploads.errorMessage(item.errorCode)}` : ""}`;
        row.dataset.complete = String(Boolean(item.assetId && ["none", "complete"].includes(item.albumStatus)));
        row.dataset.error = String(Boolean(item.errorCode));
        row.append(title, detail);
        return row;
      });
      elements["results-list"].replaceChildren(...rows);
    }

    async function history() {
      const ownerId = account.ownerId;
      const currentEpoch = epoch;
      const savedJobs = await store.list(ownerId);
      if (!account.signedIn || account.ownerId !== ownerId || epoch !== currentEpoch) return;
      const rows = savedJobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((saved) => {
        const row = document.createElement("li");
        const link = document.createElement("a");
        link.href = `upload.html?job=${encodeURIComponent(saved.id)}`;
        link.addEventListener("click", (event) => preserveTransfer(event, link));
        const title = document.createElement("strong");
        title.textContent = `${saved.items.length} image${saved.items.length === 1 ? "" : "s"} to Immich`;
        const date = document.createElement("span");
        date.textContent = new Date(saved.createdAt).toLocaleString();
        link.append(title, date);
        const status = document.createElement("span");
        status.className = "status-badge";
        status.dataset.tone = { complete: "success", running: "busy", queued: "" }[saved.status] ?? "warning";
        status.textContent = { complete: "Complete", running: "Uploading", queued: "Ready" }[saved.status] || "Needs attention";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove record";
        remove.disabled = busy && job?.id === saved.id;
        remove.addEventListener("click", () => act(async () => {
          await locks.request(`upload:${saved.id}`, { ifAvailable: true }, async (lock) => {
            if (!lock) throw new Error("This upload is active in another tab.");
            await store.remove(saved.id, account.ownerId);
            if (job?.id === saved.id) { job = null; items = []; files = []; }
          });
          await history();
        }));
        row.append(link, status, remove);
        return row;
      });
      elements["history-list"].replaceChildren(...rows);
      elements["history-empty"].hidden = rows.length > 0;
    }

    function setAlbums() {
      const connection = selectedConnection();
      destinationId = connection?.id || "";
      destinationJobId = job?.id || null;
      const library = document.createElement("option");
      library.value = "";
      library.textContent = "Library — no album";
      elements["album-select"].replaceChildren(library);
      const defaultId = job ? job.albumId : connection?.defaultAlbumId;
      if (defaultId) {
        const saved = document.createElement("option");
        saved.value = defaultId;
        saved.textContent = "Saved album — load albums to check access";
        elements["album-select"].append(saved);
        elements["album-select"].value = defaultId;
      }
      elements["connection-note"].textContent = connection?.serverUrl || "Connect Immich in Integrations first.";
      render();
    }

    async function refresh() {
      const generation = ++refreshGeneration;
      const previousOwner = account.ownerId;
      const next = await client.status();
      if (generation !== refreshGeneration) return;
      account = next;
      if (!account.signedIn || account.ownerId !== previousOwner) {
        epoch += 1;
        actionController?.abort();
        client.cancel();
        items = []; files = []; job = null;
        if (previousOwner) inputRestored = true;
        connections = [];
        elements["connection-select"].replaceChildren();
        elements["local-files"].value = "";
        elements["results-list"].replaceChildren();
        elements["history-list"].replaceChildren();
      }
      render();
      if (account.signedIn) {
        const values = await client.list();
        if (generation !== refreshGeneration) return;
        connections = values;
        const previous = job?.connectionId || elements["connection-select"].value;
        elements["connection-select"].replaceChildren(...connections.map((connection) => {
          const option = document.createElement("option");
          option.value = connection.id;
          option.textContent = `Immich · ${connection.serverUrl}`;
          return option;
        }));
        if (!connections.length) {
          const option = document.createElement("option");
          option.value = "";
          option.textContent = "No connected servers";
          elements["connection-select"].append(option);
        }
        if (connections.some((connection) => connection.id === previous)) elements["connection-select"].value = previous;
        await restoreInput();
        if (generation !== refreshGeneration) return;
        if (job && !connections.some((connection) => connection.id === job.connectionId && connection.serverUrl === job.serverUrl)) {
          client.cancel();
          error("This connection was deleted or its server changed. Create a new upload with the reconfigured connection.");
        }
        await history();
      }
      if (generation !== refreshGeneration) return;
      if (destinationId !== (selectedConnection()?.id || "") || destinationJobId !== (job?.id || null)) setAlbums();
      else render();
    }

    async function act(callback) {
      if (busy) return;
      busy = true;
      actionController = new AbortController();
      error(); render();
      try { await callback(actionController.signal); }
      catch (failure) { error(failure.message || "The upload could not finish. Retry unfinished steps."); }
      finally { busy = false; actionController = null; render(); }
    }

    async function restoreInput() {
      if (inputRestored || !account.signedIn) return;
      if (restoring) return restoring;
      const ownerId = account.ownerId;
      const currentEpoch = epoch;
      const current = () => account.signedIn && account.ownerId === ownerId && epoch === currentEpoch;
      restoring = (async () => {
        const requestId = params.get("request");
        const jobId = params.get("job");
        if (requestId) {
          if (!ID.test(requestId)) throw new Error("Invalid selected-image request.");
          const key = `uploadJobRequest:${requestId}`;
          const selected = validateRequest((await browser.storage.session.get(key))[key]);
          if (!current()) return;
          items = selected;
          await browser.storage.session.remove(key);
        } else if (jobId) {
          if (!ID.test(jobId)) throw new Error("Invalid saved upload.");
          await locks.request(`upload:${jobId}`, { ifAvailable: true }, async (lock) => {
            if (!lock) throw new Error("This upload is active in another tab. Use that tab to control it.");
            const saved = (await store.list(ownerId)).find((entry) => entry.id === jobId);
            if (!current()) return;
            if (!saved) throw new Error("This upload is unavailable for the signed-in account.");
            const restored = Uploads.recoverJob(saved);
            await store.save(restored);
            if (current()) {
              job = restored;
              if (connections.some((connection) => connection.id === job.connectionId)) elements["connection-select"].value = job.connectionId;
            }
          });
        }
        if (current()) inputRestored = true;
      })();
      try { await restoring; } finally { restoring = null; }
    }

    function permissions(connection, requestedItems) {
      const origins = new Set([provider.permissionPattern(connection.serverUrl)]);
      for (const item of requestedItems) if (item.url) {
        const url = new URL(item.url);
        if (["http:", "https:"].includes(url.protocol)) origins.add(`${url.protocol}//${url.hostname}/*`);
      }
      // Invoked directly by the click handler, before awaiting anything.
      return browser.permissions.request({ origins: [...origins] });
    }

    async function fetchImage(item, signal) {
      if (item.source === "file") {
        const file = files.find((candidate) => Core.sanitizeFilename(candidate.name) === item.filename &&
          candidate.size === item.size && candidate.lastModified === item.lastModified);
        if (!file) { const missing = new Error("Reselect the original local image."); missing.code = "file_required"; throw missing; }
        return file;
      }
      return imageFetch.fetchImageBytes(item.url, signal, {
        permissionContains: (pattern) => browser.permissions.contains({ origins: [pattern] })
      });
    }

    function begin(retry) {
      if (busy || !account.signedIn) return;
      const connection = selectedConnection();
      if (!connection) return;
      const requestedOwner = account.ownerId;
      const currentEpoch = epoch;
      const requestedAlbum = retry ? job.albumId : elements["album-select"].value || null;
      const requestedItems = retry ? job.items : structuredClone(items);
      let permission;
      try { permission = permissions(connection, requestedItems); }
      catch (_failure) { error("Firefox could not request access to the server and image hosts."); return; }
      return act(async (actionSignal) => {
        if (!await permission) throw new Error("Server and source-image access is required. Click Upload or Retry to grant it.");
        actionSignal.throwIfAborted();
        const status = await client.status();
        actionSignal.throwIfAborted();
        if (!status.signedIn || status.ownerId !== requestedOwner || account.ownerId !== requestedOwner || epoch !== currentEpoch) {
          throw new Error("The account changed. Reopen Uploads.");
        }
        if (!retry) {
          const created = Uploads.createJob(requestedItems, { ownerId: requestedOwner, connectionId: connection.id,
            serverUrl: connection.serverUrl, albumId: requestedAlbum });
          await store.save(created);
          job = created;
          root.history?.replaceState(null, "", `?job=${encodeURIComponent(job.id)}`);
        }
        if (job.connectionId !== connection.id || job.serverUrl !== connection.serverUrl || job.ownerId !== account.ownerId) {
          throw new Error("The saved connection changed. Create a new upload for this server.");
        }
        const activeJob = job;
        await locks.request(`upload:${activeJob.id}`, { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error("This upload is active in another tab. Use that tab to control it.");
          // Reload inside the lock so two tabs cannot retry a stale asset upload.
          job = Uploads.recoverJob((await store.list(account.ownerId)).find((entry) => entry.id === activeJob.id));
          // A failed checkpoint can leave a confirmed asset only in this tab's memory.
          // Save that identity before retrying; never throw it away and upload again.
          const retained = Uploads.recoverJob(activeJob);
          if (["id", "ownerId", "connectionId", "serverUrl", "albumId"].every((key) => retained[key] === job[key])) {
            for (const [index, item] of job.items.entries()) {
              const known = retained.items[index];
              if (!known || !known.assetId || !["id", "url", "source", "filename", "size", "lastModified"].every((key) => known[key] === item[key])) continue;
              if (!item.assetId) Object.assign(item, { assetId: known.assetId, duplicate: known.duplicate,
                uploadStatus: "complete", albumStatus: known.albumStatus, errorCode: known.errorCode });
              else if (item.assetId === known.assetId && known.albumStatus === "complete") {
                item.albumStatus = "complete";
                item.errorCode = "";
              }
            }
          }
          job = Uploads.recoverJob(job);
          await store.save(job);
          actionSignal.throwIfAborted();
          if (!retry) await client.defaultAlbum(connection.id, job.albumId);
          const runningJob = job;
          await client.withCredential(connection, async (credential, { signal }) => {
            if (epoch !== currentEpoch) throw new Error("The account changed. Reopen Uploads.");
            const combined = AbortSignal.any([signal, actionSignal]);
            combined.throwIfAborted();
            render();
            elements["progress-panel"].scrollIntoView({ block: "start" });
            await Uploads.run(runningJob, { credential, signal: combined, provider, fetchImage,
              onChange: async (changed) => {
                await store.save(changed);
                if (epoch === currentEpoch) { job = changed; render(); }
              }
            });
          });
        });
        if (epoch === currentEpoch) await history();
      });
    }

    elements["connection-select"].addEventListener("change", setAlbums);
    elements["albums-button"].addEventListener("click", () => {
      if (busy) return;
      const connection = selectedConnection();
      if (!connection) return;
      const permission = permissions(connection, []);
      act(async (actionSignal) => {
        if (!await permission) throw new Error("Grant access to the Immich server to list albums.");
        actionSignal.throwIfAborted();
        const albums = await client.withCredential(connection, (credential, { signal }) =>
          provider.listAlbums(credential, { signal: AbortSignal.any([signal, actionSignal]) }));
        const previous = elements["album-select"].value;
        setAlbums();
        // Remove the unverified saved choice; a missing album must not silently become the library.
        while (elements["album-select"].options.length > 1) elements["album-select"].remove(1);
        for (const album of albums) {
          const option = document.createElement("option"); option.value = album.id; option.textContent = album.name;
          elements["album-select"].append(option);
        }
        if (previous && !albums.some((album) => album.id === previous)) {
          const unavailable = document.createElement("option"); unavailable.value = previous;
          unavailable.textContent = "Saved album unavailable — choose another album or Library";
          elements["album-select"].append(unavailable);
          error("The saved album is no longer writable. Choose an available destination before uploading.");
        }
        elements["album-select"].value = previous;
      });
    });
    elements["local-files"].addEventListener("change", () => {
      if (busy) return;
      files = [...elements["local-files"].files];
      if (files.length > 500) { files = []; error("Choose at most 500 images."); }
      if (!job) items = files.map((file) => ({ source: "file", filename: file.name, size: file.size,
        lastModified: file.lastModified, mediaType: "image" }));
      render();
    });
    elements["start-button"].addEventListener("click", () => begin(false));
    elements["retry-button"].addEventListener("click", () => begin(true));
    elements["cancel-button"].addEventListener("click", () => { actionController?.abort(); client.cancel(); });
    root.addEventListener?.("pagehide", () => { epoch += 1; client.dispose(); files = []; items = []; }, { once: true });
    root.addEventListener?.("focus", () => { if (!busy) refresh().catch(() => error("Could not refresh your account. Reopen this page.")); });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["cloudSync:v1"]) refresh().catch(() => { client.cancel(); error("Account access changed. Reopen this page."); });
    });
    browser.runtime.onMessage.addListener((message, sender) => {
      if (message?.type === "INTEGRATIONS_CHANGED" && sender?.id === browser.runtime.id) refresh().catch(() => { client.cancel(); error("The saved connection changed. Reopen this page."); });
    });
    for (const link of document.querySelectorAll("a")) link.addEventListener("click", (event) => preserveTransfer(event, link), true);

    await refresh();
    render();
    return { store, begin, refresh, get job() { return job; } };
  }

  const api = { initialize, createStore, validateRequest, STORE_KEY };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AnyDownloadUploadPage = api;
  if (root.document && root.browser) root.document.addEventListener("DOMContentLoaded", () => {
    initialize().catch((failure) => {
      const banner = root.document.getElementById("error-banner");
      banner.hidden = false; banner.textContent = failure.message || "Uploads could not open.";
    });
  }, { once: true });
})(globalThis);
