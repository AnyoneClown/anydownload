(function attachUploadPage(root) {
  "use strict";
  const Core = root.ImageDownloaderCore || (typeof module === "object" ? require("../shared/core.js") : null);
  const Uploads = root.ImageDownloaderUploads || (typeof module === "object" ? require("../shared/uploads.js") : null);
  const STORE_KEY = "externalUploads:v1";
  const INDEX_KEY = "externalUploads:index:v2";
  const JOB_KEY_PREFIX = "externalUploads:job:v2:";
  const MAX_JOBS = 20;
  const MAX_BYTES = 4 * 1024 * 1024;
  const ID = /^[a-z0-9-]{8,80}$/i;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function createStore(browser, locks) {
    const keyFor = (id) => `${JOB_KEY_PREFIX}${id}`;
    const invalid = () => new Error("Saved upload records are invalid.");
    const full = () => new Error("Upload history is full. Remove an old upload record before starting another.");
    const bytesFor = (job) => new TextEncoder().encode(JSON.stringify(job)).length;
    let initialized = false;
    let initializing = null;

    function entryFor(job) {
      if (!job || typeof job.id !== "string" || !ID.test(job.id) ||
          typeof job.ownerId !== "string" || !job.ownerId ||
          !Array.isArray(job.items) || job.items.length > Uploads.MAX_ITEMS ||
          typeof job.createdAt !== "string" || !Uploads.JOB_STATUSES.includes(job.status)) throw invalid();
      return { id: job.id, ownerId: job.ownerId, bytes: bytesFor(job), createdAt: job.createdAt,
        status: job.status, total: job.items.length,
        videos: job.items.filter((item) => item.mediaType === "video").length };
    }

    function checkedIndex(value) {
      if (value === undefined) return { schemaVersion: 2, jobs: [] };
      if (!value || value.schemaVersion !== 2 || !Array.isArray(value.jobs) ||
          value.jobs.length > MAX_JOBS) throw invalid();
      const seen = new Set();
      for (const entry of value.jobs) {
        if (!entry || typeof entry.id !== "string" || !ID.test(entry.id) ||
            typeof entry.ownerId !== "string" || !entry.ownerId ||
            !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
            typeof entry.createdAt !== "string" || !Uploads.JOB_STATUSES.includes(entry.status) ||
            !Number.isSafeInteger(entry.total) || entry.total < 0 || entry.total > Uploads.MAX_ITEMS ||
            !Number.isSafeInteger(entry.videos) || entry.videos < 0 || entry.videos > entry.total ||
            seen.has(entry.id)) throw invalid();
        seen.add(entry.id);
      }
      if (value.jobs.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_BYTES) throw invalid();
      return value;
    }

    async function readIndex() {
      return checkedIndex((await browser.storage.local.get(INDEX_KEY))[INDEX_KEY]);
    }

    async function ensureMigrated() {
      if (initialized) return;
      if (initializing) return initializing;
      initializing = locks.request(STORE_KEY, async () => {
        const stored = await browser.storage.local.get([INDEX_KEY, STORE_KEY]);
        let index = checkedIndex(stored[INDEX_KEY]);
        let legacy = stored[STORE_KEY];
        if (legacy === undefined) {
          initialized = true;
          return;
        }
        if (!Array.isArray(legacy) || legacy.length > MAX_JOBS) throw invalid();
        const remaining = legacy.map(entryFor);
        const ids = [...index.jobs, ...remaining].map((entry) => entry.id);
        if (ids.length > MAX_JOBS || new Set(ids).size !== ids.length ||
            [...index.jobs, ...remaining].reduce((sum, entry) => sum + entry.bytes, 0) > MAX_BYTES) throw invalid();
        // Move one job at a time. Each set replaces the shrinking legacy array
        // while adding its new key, so migration needs little extra space.
        while (legacy.length) {
          const job = legacy[0];
          const nextIndex = { schemaVersion: 2, jobs: [...index.jobs, entryFor(job)] };
          const nextLegacy = legacy.slice(1);
          await browser.storage.local.set({ [keyFor(job.id)]: job, [INDEX_KEY]: nextIndex,
            [STORE_KEY]: nextLegacy });
          index = nextIndex;
          legacy = nextLegacy;
        }
        await browser.storage.local.remove(STORE_KEY).catch(() => undefined);
        initialized = true;
      }).finally(() => { initializing = null; });
      return initializing;
    }

    async function list(ownerId) {
      await ensureMigrated();
      const entries = (await readIndex()).jobs.filter((entry) => entry.ownerId === ownerId);
      if (!entries.length) return [];
      const values = await browser.storage.local.get(entries.map((entry) => keyFor(entry.id)));
      return entries.map((entry) => {
        const job = values[keyFor(entry.id)];
        if (!job || job.id !== entry.id || job.ownerId !== ownerId) throw invalid();
        return job;
      });
    }

    async function summaries(ownerId) {
      await ensureMigrated();
      return (await readIndex()).jobs.filter((entry) => entry.ownerId === ownerId);
    }

    async function get(id, ownerId) {
      await ensureMigrated();
      if (!(await readIndex()).jobs.some((entry) => entry.id === id && entry.ownerId === ownerId)) return null;
      const job = (await browser.storage.local.get(keyFor(id)))[keyFor(id)];
      if (!job || job.id !== id || job.ownerId !== ownerId) throw invalid();
      return job;
    }

    async function save(job) {
      await ensureMigrated();
      const entry = entryFor(job);
      return locks.request(STORE_KEY, async () => {
        const index = await readIndex();
        const previous = index.jobs.find((item) => item.id === entry.id);
        if (previous && previous.ownerId !== entry.ownerId) throw invalid();
        const jobs = previous
          ? index.jobs.map((item) => item.id === entry.id ? entry : item)
          : [...index.jobs, entry];
        if (jobs.length > MAX_JOBS || jobs.reduce((sum, item) => sum + item.bytes, 0) > MAX_BYTES) throw full();
        await browser.storage.local.set({ [keyFor(entry.id)]: job, [INDEX_KEY]: { schemaVersion: 2, jobs } });
      });
    }

    async function remove(id, ownerId) {
      await ensureMigrated();
      return locks.request(STORE_KEY, async () => {
        const index = await readIndex();
        if (!index.jobs.some((entry) => entry.id === id && entry.ownerId === ownerId)) return;
        await browser.storage.local.set({ [INDEX_KEY]: {
          schemaVersion: 2, jobs: index.jobs.filter((entry) => entry.id !== id)
        } });
        await browser.storage.local.remove(keyFor(id));
      });
    }
    return {
      list, summaries, get, save, remove
    };
  }

  function validateRequest(value) {
    if (!value || value.incognito !== false || !Number.isFinite(value.createdAt) ||
        Date.now() - value.createdAt > 600000 || value.createdAt > Date.now() + 60000 ||
        !Array.isArray(value.items) || !value.items.length || value.items.length > 500) {
      throw new Error("The selected-media request expired or is invalid. Select the media again.");
    }
    if (value.connectionId !== undefined && !UUID.test(value.connectionId) ||
        value.albumId != null && !UUID.test(value.albumId) ||
        value.albumName !== undefined && (typeof value.albumName !== "string" || value.albumName.length > 200) ||
        value.autoStart !== undefined && typeof value.autoStart !== "boolean") {
      throw new Error("The selected-media destination is invalid. Choose it again.");
    }
    return {
      items: value.items,
      connectionId: value.connectionId || "",
      albumId: value.albumId || null,
      albumName: value.albumName || "",
      autoStart: value.autoStart === true
    };
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
    let requestedConnectionId = "";
    let requestedAlbumId = null;
    let requestedAlbumName = "";
    let autoStart = false;
    let renderedJobId = null;
    let renderedRows = new Map();
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
    function mediaLabel(values) {
      const total = Array.isArray(values) ? values.length : Number(values && values.total) || 0;
      const videos = Array.isArray(values) ? values.filter((item) => item.mediaType === "video").length
        : Number(values && values.videos) || 0;
      if (videos === total && total) return `${total} video${total === 1 ? "" : "s"}`;
      if (!videos) return `${total} image${total === 1 ? "" : "s"}`;
      return `${total} media files`;
    }
    function updateResultRow(item, entry) {
      const asset = item.assetId ? item.duplicate ? "Already in Immich" : "Uploaded to Immich" : {
        pending: "Waiting to upload", fetching: `Reading ${item.mediaType === "video" ? "video" : "image"}…`, uploading: "Uploading…",
        failed: "Upload failed", uncertain: "Upload needs confirmation", cancelled: "Cancelled"
      }[item.uploadStatus];
      const album = item.assetId && job.albumId ? {
        pending: "Album step pending", attaching: "Adding to album…", complete: "Added to album", failed: "Album step failed"
      }[item.albumStatus] : "";
      const description = `${asset}${album ? ` · ${album}` : ""}${item.errorCode ? ` — ${Uploads.errorMessage(item.errorCode)}` : ""}`;
      if (entry.title.textContent !== item.filename) entry.title.textContent = item.filename;
      if (entry.detail.textContent !== description) entry.detail.textContent = description;
      entry.row.dataset.complete = String(Boolean(item.assetId && ["none", "complete"].includes(item.albumStatus)));
      entry.row.dataset.error = String(Boolean(item.errorCode));
    }

    function render(changedItemId = null) {
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
      const selectedMedia = job ? job.items : items;
      const mediaKind = selectedMedia.some((item) => item.mediaType === "video")
        ? selectedMedia.some((item) => item.mediaType !== "video") ? "media" : "videos"
        : "images";
      elements["retry-button"].textContent = busy ? "Uploading…" : `Retry unfinished ${mediaKind}`;
      elements["retry-button"].disabled = busy || !selectedConnection() || Boolean(job &&
        (job.connectionId !== selectedConnection()?.id || job.serverUrl !== selectedConnection()?.serverUrl));
      elements["cancel-button"].disabled = !busy;
      elements["selection-count"].textContent = mediaLabel(selectedMedia);
      elements["selection-note"].textContent = job
        ? job.status === "complete" ? "All media uploaded. Choose New upload to send more." : "To retry local media after reopening, choose the original files again."
        : items.length ? "Ready to upload. Choosing local files replaces this selection." : "Select up to 500 images and videos for one upload.";
      if (busy && job && job.status !== "complete") {
        elements["selection-note"].textContent = `Uploading ${mediaLabel(job.items)}. Keep this view open.`;
      }
      elements["progress-empty"].hidden = Boolean(job);
      elements["progress-panel"].dataset.state = job?.status || "ready";
      if (!job) {
        elements["progress-heading"].textContent = "Ready when you are";
        elements["progress-summary"].textContent = "No upload started.";
        elements["upload-progress"].max = 1;
        elements["upload-progress"].value = 0;
        if (renderedJobId !== null) elements["results-list"].replaceChildren();
        renderedJobId = null;
        renderedRows = new Map();
        return;
      }
      const complete = job.items.filter((item) => item.assetId && (item.albumStatus === "none" || item.albumStatus === "complete")).length;
      elements["progress-heading"].textContent = job.status === "complete" ? "Upload complete" : busy ? "Uploading…" : "Ready to retry";
      elements["upload-progress"].max = job.items.length;
      elements["upload-progress"].value = complete;
      elements["progress-summary"].textContent = `${complete} of ${mediaLabel(job.items)} complete${complete < job.items.length ? ` · ${job.items.length - complete} unfinished` : ""}.`;
      if (renderedJobId !== job.id || renderedRows.size !== job.items.length) {
        renderedRows = new Map();
        const rows = job.items.map((item) => {
          const row = document.createElement("li");
          const title = document.createElement("strong");
          const detail = document.createElement("span");
          row.append(title, detail);
          const entry = { row, title, detail };
          renderedRows.set(item.id, entry);
          updateResultRow(item, entry);
          return row;
        });
        elements["results-list"].replaceChildren(...rows);
        renderedJobId = job.id;
      } else if (changedItemId && renderedRows.has(changedItemId)) {
        const item = job.items.find((candidate) => candidate.id === changedItemId);
        if (item) updateResultRow(item, renderedRows.get(changedItemId));
      } else {
        for (const item of job.items) updateResultRow(item, renderedRows.get(item.id));
      }
    }

    async function history() {
      const ownerId = account.ownerId;
      const currentEpoch = epoch;
      const savedJobs = await store.summaries(ownerId);
      if (!account.signedIn || account.ownerId !== ownerId || epoch !== currentEpoch) return;
      const rows = savedJobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((saved) => {
        const row = document.createElement("li");
        const link = document.createElement("a");
        link.href = `upload.html?job=${encodeURIComponent(saved.id)}`;
        link.addEventListener("click", (event) => preserveTransfer(event, link));
        const title = document.createElement("strong");
        title.textContent = `${mediaLabel(saved)} to Immich`;
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
      const requestedId = !job && connection?.id === requestedConnectionId ? requestedAlbumId : null;
      const defaultId = job ? job.albumId : requestedId || connection?.defaultAlbumId;
      if (defaultId) {
        const saved = document.createElement("option");
        saved.value = defaultId;
        saved.textContent = requestedId && requestedAlbumName
          ? requestedAlbumName
          : "Saved album — load albums to check access";
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
          if (!ID.test(requestId)) throw new Error("Invalid selected-media request.");
          const key = `uploadJobRequest:${requestId}`;
          const selected = validateRequest((await browser.storage.session.get(key))[key]);
          if (!current()) return;
          items = selected.items;
          requestedConnectionId = selected.connectionId;
          requestedAlbumId = selected.albumId;
          requestedAlbumName = selected.albumName;
          autoStart = selected.autoStart;
          if (requestedConnectionId && connections.some((connection) => connection.id === requestedConnectionId)) {
            elements["connection-select"].value = requestedConnectionId;
          }
          await browser.storage.session.remove(key);
        } else if (jobId) {
          if (!ID.test(jobId)) throw new Error("Invalid saved upload.");
          await locks.request(`upload:${jobId}`, { ifAvailable: true }, async (lock) => {
            if (!lock) throw new Error("This upload is active in another tab. Use that tab to control it.");
            const saved = await store.get(jobId, ownerId);
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

    function permissions(connection, requestedItems, existingOnly = false) {
      const origins = new Set([provider.permissionPattern(connection.serverUrl)]);
      for (const item of requestedItems) if (item.url) {
        const url = new URL(item.url);
        if (["http:", "https:"].includes(url.protocol)) origins.add(`${url.protocol}//${url.hostname}/*`);
      }
      if (existingOnly) return browser.permissions.contains({ origins: [...origins] });
      // Invoked directly by the click handler, before awaiting anything.
      return browser.permissions.request({ origins: [...origins] });
    }

    async function fetchImage(item, signal) {
      if (item.source === "file") {
        const file = files.find((candidate) => Core.sanitizeFilename(candidate.name) === item.filename &&
          candidate.size === item.size && candidate.lastModified === item.lastModified);
        if (!file) { const missing = new Error("Reselect the original local media file."); missing.code = "file_required"; throw missing; }
        return file;
      }
      const fetchMedia = imageFetch.fetchMediaBlob || imageFetch.fetchMediaBytes;
      return fetchMedia(item.url, item.mediaType, signal, {
        permissionContains: (pattern) => browser.permissions.contains({ origins: [pattern] })
      });
    }

    function begin(retry, existingPermissionOnly = false) {
      if (busy || !account.signedIn) return;
      const connection = selectedConnection();
      if (!connection) return;
      const requestedOwner = account.ownerId;
      const currentEpoch = epoch;
      const requestedAlbum = retry ? job.albumId : elements["album-select"].value || null;
      const requestedItems = retry ? job.items : structuredClone(items);
      let permission;
      try { permission = permissions(connection, requestedItems, existingPermissionOnly); }
      catch (_failure) { error("Firefox could not request access to the server and media hosts."); return; }
      return act(async (actionSignal) => {
        if (!await permission) throw new Error(existingPermissionOnly
          ? "Media access changed before the upload started. Return to Media and choose Upload selected again."
          : "Server and source-media access is required. Click Upload or Retry to grant it.");
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
          job = Uploads.recoverJob(await store.get(activeJob.id, account.ownerId));
          // A failed checkpoint can leave a confirmed asset only in this tab's memory.
          // Save that identity before retrying; never throw it away and upload again.
          const retained = Uploads.recoverJob(activeJob);
          if (["id", "ownerId", "connectionId", "serverUrl", "albumId"].every((key) => retained[key] === job[key])) {
            for (const [index, item] of job.items.entries()) {
              const known = retained.items[index];
              if (!known || !known.assetId || !["id", "url", "source", "filename", "mediaType", "size", "lastModified"].every((key) => known[key] === item[key])) continue;
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
              onChange: async (changed, changedItem, durable) => {
                if (durable !== false) await store.save(changed);
                if (epoch === currentEpoch) { job = changed; render(changedItem?.id); }
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
      if (files.length > 500) { files = []; error("Choose at most 500 images and videos."); }
      if (!job) items = files.map((file) => ({ source: "file", filename: file.name, size: file.size,
        lastModified: file.lastModified,
        mediaType: /^video\//i.test(file.type) || /\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)$/i.test(file.name) ? "video" : "image" }));
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
    if (autoStart && items.length && selectedConnection()) {
      autoStart = false;
      await begin(false, true);
    }
    return { store, begin, refresh, get job() { return job; } };
  }

  const api = { initialize, createStore, validateRequest, STORE_KEY, INDEX_KEY, JOB_KEY_PREFIX };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AnyDownloadUploadPage = api;
  if (root.document && root.browser) root.document.addEventListener("DOMContentLoaded", () => {
    initialize().catch((failure) => {
      const banner = root.document.getElementById("error-banner");
      banner.hidden = false; banner.textContent = failure.message || "Uploads could not open.";
    });
  }, { once: true });
})(globalThis);
