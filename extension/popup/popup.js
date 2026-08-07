(function exposeDimensionProbeScheduler(globalScope) {
  "use strict";

  function createDimensionProbeScheduler(options) {
    const settings = Object.assign({
      maxConcurrency: 3,
      timeoutMs: 15000,
      createImage: () => new Image(),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timerId) => clearTimeout(timerId),
      isPaused: () => false,
      canStart: () => true
    }, options || {});
    const records = new Map();
    const queue = [];
    let activeCount = 0;

    function safeResult(result) {
      return {
        width: Number(result && result.width) || 0,
        height: Number(result && result.height) || 0,
        cancelled: Boolean(result && result.cancelled)
      };
    }

    function cancelRecord(record) {
      if (!record || record.status !== "queued") {
        return false;
      }
      record.status = "cancelled";
      if (records.get(record.url) === record) {
        records.delete(record.url);
      }
      record.resolve(safeResult({ cancelled: true }));
      return true;
    }

    function startRecord(record) {
      record.status = "loading";
      activeCount += 1;
      let probe = null;
      let timerId = null;
      let settled = false;

      function finish(result) {
        if (settled) {
          return;
        }
        settled = true;
        if (timerId !== null) {
          settings.clearTimer(timerId);
        }
        if (probe) {
          probe.onload = null;
          probe.onerror = null;
        }
        activeCount = Math.max(0, activeCount - 1);
        record.status = "settled";
        record.result = safeResult(result);
        record.resolve(record.result);
        pump();
      }

      try {
        probe = settings.createImage();
        if (!probe) {
          throw new Error("The image probe could not be created.");
        }
        probe.referrerPolicy = "no-referrer";
        probe.decoding = "async";
        probe.fetchPriority = "low";
        probe.onload = () => finish({
          width: probe.naturalWidth,
          height: probe.naturalHeight
        });
        probe.onerror = () => finish({ width: 0, height: 0 });
        timerId = settings.setTimer(() => {
          if (settled) {
            return;
          }
          probe.onload = null;
          probe.onerror = null;
          try {
            probe.src = "";
          } catch (_error) {
            // The failure result below still releases the queue slot.
          }
          finish({ width: 0, height: 0 });
        }, settings.timeoutMs);
        probe.src = record.url;
      } catch (_error) {
        finish({ width: 0, height: 0 });
      }
    }

    function pump() {
      let paused = true;
      try {
        paused = Boolean(settings.isPaused());
      } catch (_error) {
        paused = true;
      }
      if (paused) {
        return;
      }

      while (activeCount < settings.maxConcurrency && queue.length) {
        const record = queue.shift();
        if (!record || record.status !== "queued") {
          continue;
        }
        let allowed = false;
        try {
          allowed = Boolean(settings.canStart(record.url, record.context));
        } catch (_error) {
          allowed = false;
        }
        if (!allowed) {
          cancelRecord(record);
          continue;
        }
        startRecord(record);
      }
    }

    function request(url, context) {
      const existing = records.get(url);
      if (existing) {
        return existing.promise;
      }

      let resolveRecord;
      const promise = new Promise((resolve) => {
        resolveRecord = resolve;
      });
      const record = {
        url,
        context,
        status: "queued",
        result: null,
        resolve: resolveRecord,
        promise
      };
      records.set(url, record);
      queue.push(record);
      pump();
      return promise;
    }

    function cancelQueued(predicate) {
      const cancelledUrls = [];
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const record = queue[index];
        if (record.status !== "queued" || !predicate(record.url, record.context)) {
          continue;
        }
        queue.splice(index, 1);
        if (cancelRecord(record)) {
          cancelledUrls.push(record.url);
        }
      }
      return cancelledUrls;
    }

    function getResult(url) {
      const record = records.get(url);
      return record && record.status === "settled" ? record.result : null;
    }

    function getStatus(url) {
      const record = records.get(url);
      return record ? record.status : "none";
    }

    return {
      request,
      pump,
      cancelQueued,
      getResult,
      getStatus,
      get activeCount() {
        return activeCount;
      },
      get queuedCount() {
        return queue.filter((record) => record.status === "queued").length;
      }
    };
  }

  if (typeof module === "object" && module && module.exports) {
    module.exports = { createDimensionProbeScheduler };
    return;
  }

  (function initializePopup() {
    "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const collectImagesFromPage = globalThis.ImageDownloaderCollector;
  const MAX_DISCOVERED_IMAGES = Core.MAX_BATCH_SIZE;
  const MAX_SCANNED_ELEMENTS = 10000;
  const MAX_RENDERED_ROWS = 350;
  const MAX_DIMENSION_PROBE_CONCURRENCY = 3;
  const DIMENSION_PROBE_TIMEOUT_MS = 15000;
  const MAX_IGNORED_PER_SITE = 500;
  const MAX_IGNORED_RULES = 5000;
  const IGNORE_STORAGE_PREFIX = "ignoredImage:";

  const state = {
    images: [],
    selected: new Set(),
    scanWarnings: [],
    busy: false,
    hasStoredFolder: false,
    incognito: false,
    ignoredKeys: new Set(),
    showIgnored: false,
    siteKey: "",
    windowId: null
  };

  const elements = {};
  const renderedMetaNodes = new Map();
  const visibleDimensionRows = new Map();
  let thumbnailObserver = null;
  let dimensionObserver = null;
  let ignoreWriteQueue = Promise.resolve();
  let renderGeneration = 0;

  const dimensionProbeScheduler = createDimensionProbeScheduler({
    maxConcurrency: MAX_DIMENSION_PROBE_CONCURRENCY,
    timeoutMs: DIMENSION_PROBE_TIMEOUT_MS,
    isPaused: () => state.busy,
    canStart: (url, context) => {
      const visible = visibleDimensionRows.get(url);
      return Boolean(
        context &&
        context.generation === renderGeneration &&
        visible &&
        visible.generation === context.generation &&
        visible.row &&
        visible.row.isConnected &&
        elements["image-list"] &&
        elements["image-list"].contains(visible.row)
      );
    }
  });

  function cacheElements() {
    const ids = [
      "action-detail",
      "ask-single-input",
      "backgrounds-input",
      "clear-ignored-button",
      "download-button",
      "filter-input",
      "folder-help",
      "folder-input",
      "ignored-button",
      "image-list",
      "notice",
      "page-label",
      "rescan-button",
      "select-all-button",
      "select-none-button",
      "selected-label",
      "summary-label"
    ];
    for (const id of ids) {
      elements[id] = document.getElementById(id);
    }
  }

  function setNotice(message, type) {
    elements.notice.textContent = message || "";
    elements.notice.className = `notice${type ? ` ${type}` : ""}`;
    elements.notice.hidden = !message;
  }

  function hostFromUrl(value) {
    try {
      return new URL(value).hostname || "this page";
    } catch (_error) {
      return "this page";
    }
  }

  function validIgnoredKey(value) {
    return /^(?:data|url):\d{1,7}:[a-f0-9]{16}$/.test(String(value || ""));
  }

  function ignoreStorageArea(incognito) {
    return incognito ? browser.storage.session : browser.storage.local;
  }

  function ignoreStoragePrefix(siteKey) {
    return `${IGNORE_STORAGE_PREFIX}${encodeURIComponent(siteKey)}:`;
  }

  async function pruneIgnoredStorage(area, stored) {
    const entries = Object.entries(stored || {})
      .filter(([key]) => key.startsWith(IGNORE_STORAGE_PREFIX));
    if (entries.length <= MAX_IGNORED_RULES) {
      return stored;
    }

    entries.sort((left, right) => (Number(left[1]) || 0) - (Number(right[1]) || 0));
    const keysToRemove = entries
      .slice(0, entries.length - MAX_IGNORED_RULES)
      .map(([key]) => key);
    await area.remove(keysToRemove);
    for (const key of keysToRemove) {
      delete stored[key];
    }
    return stored;
  }

  async function pruneSiteIgnoredStorage(area, stored, siteKey) {
    const prefix = ignoreStoragePrefix(siteKey);
    const entries = Object.entries(stored || {})
      .filter(([key]) => key.startsWith(prefix));
    if (entries.length <= MAX_IGNORED_PER_SITE) {
      return stored;
    }

    entries.sort((left, right) => (Number(left[1]) || 0) - (Number(right[1]) || 0));
    const keysToRemove = entries
      .slice(0, entries.length - MAX_IGNORED_PER_SITE)
      .map(([key]) => key);
    await area.remove(keysToRemove);
    for (const key of keysToRemove) {
      delete stored[key];
    }
    return stored;
  }

  async function loadIgnoredKeys() {
    if (!state.siteKey) {
      state.ignoredKeys.clear();
      return;
    }

    const area = ignoreStorageArea(state.incognito);
    const prefix = ignoreStoragePrefix(state.siteKey);
    const stored = await pruneIgnoredStorage(area, await area.get(null));
    const keys = Object.keys(stored || {})
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter(validIgnoredKey)
      .slice(0, MAX_IGNORED_PER_SITE);
    state.ignoredKeys = new Set(keys);
  }

  function handleIgnoredStorageChanges(changes, areaName) {
    const expectedArea = state.incognito ? "session" : "local";
    if (!state.siteKey || areaName !== expectedArea) {
      return;
    }

    const prefix = ignoreStoragePrefix(state.siteKey);
    let changed = false;
    for (const [storageKey, change] of Object.entries(changes || {})) {
      if (!storageKey.startsWith(prefix)) {
        continue;
      }
      const imageKey = storageKey.slice(prefix.length);
      if (!validIgnoredKey(imageKey)) {
        continue;
      }

      const exists = Boolean(change && change.newValue !== undefined);
      if (exists && !state.ignoredKeys.has(imageKey)) {
        state.ignoredKeys.add(imageKey);
        for (const image of state.images) {
          if (ignoredKey(image) === imageKey) {
            state.selected.delete(image.url);
          }
        }
        changed = true;
      } else if (!exists && state.ignoredKeys.delete(imageKey)) {
        changed = true;
      }
    }

    if (changed && !state.busy) {
      renderImages();
    }
  }

  function ignoredKey(image) {
    return Core.ignoreKeyForUrl(image && image.url);
  }

  function isImageIgnored(image) {
    const key = ignoredKey(image);
    return Boolean(key && state.ignoredKeys.has(key));
  }

  function focusIgnoredToggle() {
    try {
      elements["ignored-button"].focus({ preventScroll: true });
    } catch (_error) {
      elements["ignored-button"].focus();
    }
  }

  function persistIgnoredMutation(action, imageKey) {
    const siteKey = state.siteKey;
    const incognito = state.incognito;
    if (!siteKey || !validIgnoredKey(imageKey)) {
      return Promise.reject(new Error("The ignore rule is invalid."));
    }

    const storageKey = `${ignoreStoragePrefix(siteKey)}${imageKey}`;
    ignoreWriteQueue = ignoreWriteQueue
      .catch(() => undefined)
      .then(async () => {
        const area = ignoreStorageArea(incognito);
        if (action !== "add") {
          await area.remove(storageKey);
          return;
        }

        await area.set({ [storageKey]: Date.now() });
        let stored = await area.get(null);
        stored = await pruneIgnoredStorage(area, stored);
        await pruneSiteIgnoredStorage(area, stored, siteKey);
      });
    return ignoreWriteQueue;
  }

  function clearPersistedIgnoredRules() {
    const siteKey = state.siteKey;
    const incognito = state.incognito;
    if (!siteKey) {
      return Promise.resolve();
    }

    const prefix = ignoreStoragePrefix(siteKey);
    ignoreWriteQueue = ignoreWriteQueue
      .catch(() => undefined)
      .then(async () => {
        const area = ignoreStorageArea(incognito);
        const stored = await area.get(null);
        const keys = Object.keys(stored || {}).filter((key) => key.startsWith(prefix));
        if (keys.length) {
          await area.remove(keys);
        }
      });
    return ignoreWriteQueue;
  }

  async function ignoreImage(image) {
    const key = ignoredKey(image);
    if (!state.siteKey || !key) {
      setNotice("This image cannot be added to the ignore list.", "error");
      return;
    }
    if (!state.ignoredKeys.has(key) && state.ignoredKeys.size >= MAX_IGNORED_PER_SITE) {
      setNotice(`This website already has the maximum of ${MAX_IGNORED_PER_SITE} ignored image rules.`, "error");
      return;
    }

    state.ignoredKeys.add(key);
    for (const candidate of state.images) {
      if (ignoredKey(candidate) === key) {
        state.selected.delete(candidate.url);
      }
    }
    const privateNote = state.incognito ? " for this private session" : " on this website";
    setNotice(`Ignored ${friendlyFilename(image)}${privateNote}. Use the Ignored view to restore it.`);
    renderImages();
    focusIgnoredToggle();
    try {
      await persistIgnoredMutation("add", key);
    } catch (error) {
      setNotice(`The image is hidden for now, but Firefox could not remember it: ${error.message || error}`, "error");
    }
  }

  async function restoreImage(image) {
    const key = ignoredKey(image);
    if (!key) {
      return;
    }
    state.ignoredKeys.delete(key);
    for (const candidate of state.images) {
      if (ignoredKey(candidate) === key) {
        state.selected.delete(candidate.url);
      }
    }
    setNotice(`Restored ${friendlyFilename(image)}. It remains unselected.`);
    renderImages();
    focusIgnoredToggle();
    try {
      await persistIgnoredMutation("remove", key);
    } catch (error) {
      setNotice(`The image is restored for now, but Firefox could not remember it: ${error.message || error}`, "error");
    }
  }

  async function restoreAllIgnoredImages() {
    if (
      state.ignoredKeys.size > 1 &&
      !window.confirm(
        `Restore all ${state.ignoredKeys.size.toLocaleString()} ignored-image rules for this website? Restored images will remain unselected.`
      )
    ) {
      return;
    }
    const keysToRestore = new Set(state.ignoredKeys);
    for (const image of state.images) {
      if (keysToRestore.has(ignoredKey(image))) {
        state.selected.delete(image.url);
      }
    }
    state.ignoredKeys.clear();
    setNotice(`Restored all ignored-image rules for this website. Restored images remain unselected.`);
    renderImages();
    focusIgnoredToggle();
    try {
      await clearPersistedIgnoredRules();
    } catch (error) {
      setNotice(`The images are restored for now, but Firefox could not clear the stored rules: ${error.message || error}`, "error");
    }
  }

  function createPreviewId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const random = crypto.getRandomValues(new Uint32Array(2));
    return `${Date.now().toString(36)}-${random[0].toString(36)}-${random[1].toString(36)}`;
  }

  async function openImagePreview(image) {
    const urlResult = Core.validateDownloadUrl(image && image.url);
    if (!urlResult.ok) {
      setNotice(`Cannot preview this image: ${urlResult.error}`, "error");
      return;
    }

    const id = createPreviewId();
    const key = `imagePreview:${id}`;
    const payload = {
      url: urlResult.value,
      name: friendlyFilename(image),
      alt: String(image.alt || "").slice(0, 500),
      createdAt: Date.now()
    };
    try {
      await browser.storage.session.set({ [key]: payload });
    } catch (error) {
      setNotice(`Firefox could not prepare the in-memory preview: ${error.message || error}`, "error");
      return;
    }

    const previewUrl = browser.runtime.getURL(`preview/preview.html?id=${encodeURIComponent(id)}`);
    const createProperties = { url: previewUrl, active: true };
    if (Number.isInteger(state.windowId)) {
      createProperties.windowId = state.windowId;
    }
    try {
      await browser.tabs.create(createProperties);
    } catch (error) {
      await browser.storage.session.remove(key).catch(() => undefined);
      setNotice(`Firefox could not open the preview tab: ${error.message || error}`, "error");
    }
  }

  function mergeScanResults(injectionResults) {
    const byUrl = new Map();
    const warnings = new Set();
    let primaryPage = null;
    let totalUrlLength = 0;
    let aggregateLimitReached = false;
    let scannedChildFrames = 0;

    for (const injection of injectionResults) {
      if (injection && injection.error) {
        warnings.add("At least one embedded frame could not be inspected.");
        continue;
      }
      const scan = injection && injection.result;
      if (!scan || !Array.isArray(scan.images)) {
        continue;
      }
      if (injection.frameId === 0 || !primaryPage) {
        primaryPage = {
          pageUrl: String(scan.pageUrl || "").slice(0, 16384),
          pageTitle: String(scan.pageTitle || "").slice(0, 300),
          embeddedFrameCount: Math.max(0, Number(scan.embeddedFrameCount) || 0)
        };
      }
      if (injection.frameId !== 0) {
        scannedChildFrames += 1;
      }
      for (const warning of scan.warnings || []) {
        warnings.add(String(warning).slice(0, 500));
      }
      for (const image of scan.images) {
        const urlResult = Core.validateDownloadUrl(image && image.url);
        if (!urlResult.ok) {
          continue;
        }
        const normalizedUrl = urlResult.value;
        const previewResult = image && image.previewUrl
          ? Core.validateDownloadUrl(image.previewUrl)
          : { ok: false };
        const normalizedPreviewUrl = previewResult.ok && previewResult.value !== normalizedUrl
          ? previewResult.value
          : "";
        const current = byUrl.get(normalizedUrl);
        if (!current) {
          if (
            byUrl.size >= MAX_DISCOVERED_IMAGES ||
            totalUrlLength + normalizedUrl.length > Core.MAX_BATCH_TOTAL_URL_LENGTH
          ) {
            aggregateLimitReached = true;
            continue;
          }
          totalUrlLength += normalizedUrl.length;
          const previewUrl = normalizedPreviewUrl &&
            totalUrlLength + normalizedPreviewUrl.length <= Core.MAX_BATCH_TOTAL_URL_LENGTH
            ? normalizedPreviewUrl
            : "";
          totalUrlLength += previewUrl.length;
          byUrl.set(normalizedUrl, {
            url: normalizedUrl,
            previewUrl,
            alt: String(image.alt || "").slice(0, 500),
            width: Math.max(0, Number(image.width) || 0),
            height: Math.max(0, Number(image.height) || 0),
            kinds: Array.from(image.kinds || [])
              .slice(0, 8)
              .map((kind) => String(kind).slice(0, 50))
          });
          continue;
        }
        for (const kind of image.kinds || []) {
          const safeKind = String(kind).slice(0, 50);
          if (current.kinds.length < 8 && !current.kinds.includes(safeKind)) {
            current.kinds.push(safeKind);
          }
        }
        current.width = Math.max(current.width || 0, image.width || 0);
        current.height = Math.max(current.height || 0, image.height || 0);
        current.alt = current.alt || String(image.alt || "").slice(0, 500);
        if (!current.previewUrl && normalizedPreviewUrl &&
          totalUrlLength + normalizedPreviewUrl.length <= Core.MAX_BATCH_TOTAL_URL_LENGTH) {
          current.previewUrl = normalizedPreviewUrl;
          totalUrlLength += normalizedPreviewUrl.length;
        }
      }
    }

    if (aggregateLimitReached) {
      warnings.add(`Combined frame results were trimmed to the ${MAX_DISCOVERED_IMAGES.toLocaleString()}-image and 2 MB safety limits.`);
    }
    if (primaryPage && primaryPage.embeddedFrameCount > scannedChildFrames) {
      warnings.add("Some embedded frames could not be inspected with temporary page access.");
    }

    return {
      page: primaryPage,
      images: Array.from(byUrl.values()),
      warnings: Array.from(warnings)
    };
  }

  function folderStatus() {
    const result = Core.validateFolderPath(elements["folder-input"].value);
    if (!result.ok) {
      elements["folder-help"].textContent = result.error;
      elements["folder-help"].classList.add("error");
      return result;
    }

    elements["folder-help"].textContent = `Will save to Downloads/${result.value}`;
    elements["folder-help"].classList.remove("error");
    return result;
  }

  function filteredImages() {
    const query = elements["filter-input"].value.trim().toLocaleLowerCase();
    const inCurrentView = state.images.filter((image) => isImageIgnored(image) === state.showIgnored);
    if (!query) {
      return inCurrentView;
    }
    return inCurrentView.filter((image) => {
      const haystack = `${image.url} ${image.alt || ""} ${(image.kinds || []).join(" ")}`.toLocaleLowerCase();
      return haystack.includes(query);
    });
  }

  function friendlyFilename(image) {
    const index = Math.max(0, state.images.indexOf(image));
    return Core.filenameForImage(image.url, index);
  }

  function validPixelDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 1000000
      ? Math.round(number)
      : 0;
  }

  function currentImageForUrl(url) {
    return state.images.find((image) => image.url === url) || null;
  }

  function applyMeasuredDimensions(image, width, height) {
    width = validPixelDimension(width);
    height = validPixelDimension(height);
    if (!width || !height) {
      image.dimensionStatus = "unavailable";
      return false;
    }
    image.width = width;
    image.height = height;
    image.dimensionStatus = "known";
    return true;
  }

  function imageMetaText(image) {
    let dimensions = "size unknown";
    if (image.width && image.height) {
      dimensions = `${Math.round(image.width).toLocaleString()} × ${Math.round(image.height).toLocaleString()}`;
    } else if (image.dimensionStatus === "loading") {
      dimensions = "checking full size…";
    } else if (image.dimensionStatus === "unavailable") {
      dimensions = "full size unavailable";
    }
    return `${dimensions} · ${(image.kinds || ["Image"]).join(", ")}`;
  }

  function registerImageMeta(meta, image) {
    let nodes = renderedMetaNodes.get(image.url);
    if (!nodes) {
      nodes = new Set();
      renderedMetaNodes.set(image.url, nodes);
    }
    nodes.add(meta);
  }

  function updateImageMetas(url) {
    const image = currentImageForUrl(url);
    const nodes = renderedMetaNodes.get(url);
    if (!image || !nodes) {
      return;
    }
    for (const meta of nodes) {
      if (meta.isConnected) {
        meta.textContent = imageMetaText(image);
      } else {
        nodes.delete(meta);
      }
    }
    if (!nodes.size) {
      renderedMetaNodes.delete(url);
    }
  }

  function applyDimensionResult(url, result) {
    const image = currentImageForUrl(url);
    if (!image) {
      return false;
    }
    const applied = applyMeasuredDimensions(image, result.width, result.height);
    updateImageMetas(url);
    return applied;
  }

  function resetCancelledDimensionStatus(url) {
    if (dimensionProbeScheduler.getStatus(url) !== "none") {
      return;
    }
    const image = currentImageForUrl(url);
    if (image && (!image.width || !image.height) && image.dimensionStatus === "loading") {
      delete image.dimensionStatus;
      updateImageMetas(url);
    }
  }

  function probeFullImageDimensions(image, generation) {
    if (image.width && image.height) {
      return Promise.resolve(true);
    }
    const cached = dimensionProbeScheduler.getResult(image.url);
    if (cached && !cached.cancelled) {
      return Promise.resolve(applyDimensionResult(image.url, cached));
    }
    image.dimensionStatus = "loading";
    updateImageMetas(image.url);
    return dimensionProbeScheduler
      .request(image.url, { generation })
      .then((result) => {
        if (result.cancelled) {
          resetCancelledDimensionStatus(image.url);
          return false;
        }
        return applyDimensionResult(image.url, result);
      });
  }

  function loadVisibleThumbnail(thumbnail) {
    const source = thumbnail.dataset.src;
    const image = thumbnail.anydownloadImage;
    if (!source || !image) {
      return;
    }
    delete thumbnail.dataset.src;
    const thumbnailIsFullImage = source === image.url;
    if (!image.width || !image.height) {
      if (thumbnailIsFullImage) {
        image.dimensionStatus = "loading";
        updateImageMetas(image.url);
        thumbnail.addEventListener("load", () => {
          const current = currentImageForUrl(image.url);
          if (current && (!current.width || !current.height)) {
            applyMeasuredDimensions(current, thumbnail.naturalWidth, thumbnail.naturalHeight);
          }
          updateImageMetas(image.url);
        }, { once: true });
        thumbnail.addEventListener("error", () => {
          const current = currentImageForUrl(image.url);
          if (current && (!current.width || !current.height)) {
            current.dimensionStatus = "unavailable";
          }
          updateImageMetas(image.url);
        }, { once: true });
      }
    }
    thumbnail.src = source;
    updateImageMetas(image.url);
  }

  function updateSummary() {
    const total = state.images.length;
    const ignoredCount = state.images.filter(isImageIgnored).length;
    const storedIgnoredCount = state.ignoredKeys.size;
    const availableCount = total - ignoredCount;
    const selected = state.selected.size;
    const visible = filteredImages();
    const hasFilter = Boolean(elements["filter-input"].value.trim());
    const folder = folderStatus();
    const viewTotal = state.showIgnored ? ignoredCount : availableCount;
    elements["summary-label"].textContent = hasFilter
      ? `${visible.length.toLocaleString()} of ${viewTotal.toLocaleString()} ${state.showIgnored ? "ignored" : "available"} shown`
      : state.showIgnored
        ? storedIgnoredCount === ignoredCount
          ? `${ignoredCount.toLocaleString()} ignored image${ignoredCount === 1 ? "" : "s"}`
          : `${ignoredCount.toLocaleString()} on this page · ${storedIgnoredCount.toLocaleString()} site rules`
        : `${availableCount.toLocaleString()} image${availableCount === 1 ? "" : "s"}`;
    elements["ignored-button"].textContent = state.showIgnored ? "Show images" : `Ignored (${storedIgnoredCount.toLocaleString()})`;
    elements["ignored-button"].disabled = state.busy || (!storedIgnoredCount && !state.showIgnored);
    elements["ignored-button"].classList.toggle("active", state.showIgnored);
    elements["ignored-button"].setAttribute("aria-pressed", String(state.showIgnored));
    elements["clear-ignored-button"].hidden = !state.showIgnored || !storedIgnoredCount;
    elements["clear-ignored-button"].disabled = state.busy;
    elements["select-all-button"].hidden = state.showIgnored;
    elements["select-none-button"].hidden = state.showIgnored;
    elements["select-all-button"].textContent = hasFilter ? "Select matches only" : "Select all";
    elements["select-none-button"].textContent = hasFilter ? "Clear matches" : "Clear";
    elements["download-button"].hidden = state.showIgnored;
    elements["selected-label"].textContent = state.showIgnored
      ? `${ignoredCount.toLocaleString()} ignored here`
      : `${selected.toLocaleString()} selected`;
    elements["action-detail"].textContent = state.showIgnored
      ? storedIgnoredCount === ignoredCount
        ? "Restore images to make them downloadable again"
        : `${storedIgnoredCount.toLocaleString()} rules saved for this site`
      : selected
        ? `Ready for Downloads/${folder.ok ? folder.value : "…"}`
        : "Choose images to download";
    elements["download-button"].textContent = selected === 1 ? "Download image" : "Download selected";
    elements["download-button"].disabled = state.busy || selected === 0 || !folder.ok;
    elements["rescan-button"].disabled = state.busy;
    elements["image-list"].setAttribute(
      "aria-label",
      state.showIgnored ? "Ignored images found on this page" : "Images found on this page"
    );
  }

  function makeImageRow(image) {
    const ignored = isImageIgnored(image);
    const row = document.createElement("article");
    row.className = `image-row${ignored ? " ignored" : ""}`;
    row.setAttribute("role", "listitem");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(image.url);
    checkbox.setAttribute("aria-label", `Select ${friendlyFilename(image)}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selected.add(image.url);
      } else {
        state.selected.delete(image.url);
      }
      updateSummary();
    });

    const thumbnailFrame = document.createElement("button");
    thumbnailFrame.type = "button";
    thumbnailFrame.className = "thumbnail-frame";
    thumbnailFrame.title = "Open image preview in a new tab";
    thumbnailFrame.setAttribute("aria-label", `Preview ${friendlyFilename(image)} in a new tab`);
    thumbnailFrame.disabled = state.busy;
    thumbnailFrame.addEventListener("click", () => openImagePreview(image));
    const thumbnail = document.createElement("img");
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.referrerPolicy = "no-referrer";
    thumbnail.dataset.src = image.previewUrl || image.url;
    thumbnail.addEventListener("error", () => thumbnail.classList.add("broken"));
    thumbnailFrame.appendChild(thumbnail);

    const copy = document.createElement("div");
    copy.className = "image-copy";
    const name = document.createElement("div");
    name.className = "image-name";
    name.textContent = friendlyFilename(image);
    name.title = image.alt || friendlyFilename(image);
    const url = document.createElement("div");
    url.className = "image-url";
    url.textContent = image.url;
    url.title = image.url;
    const meta = document.createElement("div");
    meta.className = "image-meta";
    meta.textContent = imageMetaText(image);
    registerImageMeta(meta, image);
    copy.append(name, url, meta);

    thumbnail.anydownloadImage = image;
    thumbnail.anydownloadGeneration = renderGeneration;
    row.anydownloadImage = image;
    row.anydownloadThumbnail = thumbnail;
    row.anydownloadGeneration = renderGeneration;
    if (thumbnailObserver) {
      thumbnailObserver.observe(thumbnail);
    } else {
      loadVisibleThumbnail(thumbnail);
    }
    if (dimensionObserver) {
      dimensionObserver.observe(row);
    }

    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (ignored) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "row-action-button restore";
      restore.textContent = "Restore";
      restore.title = "Stop ignoring this image";
      restore.disabled = state.busy;
      restore.addEventListener("click", () => restoreImage(image));
      actions.appendChild(restore);
      row.append(thumbnailFrame, copy, actions);
    } else {
      const ignore = document.createElement("button");
      ignore.type = "button";
      ignore.className = "row-action-button ignore";
      ignore.textContent = "Ignore";
      ignore.title = "Hide this image on this website";
      ignore.disabled = state.busy;
      ignore.addEventListener("click", () => ignoreImage(image));

      const download = document.createElement("button");
      download.type = "button";
      download.className = "row-action-button download";
      download.textContent = "Save";
      download.title = "Download only this image";
      download.disabled = state.busy;
      download.addEventListener("click", () => requestDownloads([image]));
      actions.append(ignore, download);
      row.append(checkbox, thumbnailFrame, copy, actions);
    }
    return row;
  }

  function renderImages() {
    renderGeneration += 1;
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }
    if (dimensionObserver) {
      dimensionObserver.disconnect();
    }
    visibleDimensionRows.clear();
    renderedMetaNodes.clear();
    const cancelledUrls = dimensionProbeScheduler.cancelQueued(() => true);
    for (const url of cancelledUrls) {
      resetCancelledDimensionStatus(url);
    }

    if (typeof IntersectionObserver === "function") {
      const generation = renderGeneration;
      const list = elements["image-list"];
      const nextThumbnailObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const thumbnail = entry.target;
          if (
            thumbnail.anydownloadGeneration !== generation ||
            !thumbnail.isConnected ||
            !list.contains(thumbnail)
          ) {
            nextThumbnailObserver.unobserve(thumbnail);
            continue;
          }
          if (entry.isIntersecting && thumbnail.dataset.src) {
            loadVisibleThumbnail(thumbnail);
            nextThumbnailObserver.unobserve(thumbnail);
          }
        }
      }, { root: list, rootMargin: "100px" });
      thumbnailObserver = nextThumbnailObserver;

      const nextDimensionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const row = entry.target;
          const image = row.anydownloadImage;
          if (
            !image ||
            row.anydownloadGeneration !== generation ||
            generation !== renderGeneration ||
            !row.isConnected ||
            !list.contains(row)
          ) {
            nextDimensionObserver.unobserve(row);
            continue;
          }

          if (entry.isIntersecting) {
            visibleDimensionRows.set(image.url, { row, generation });
            if (
              !state.busy &&
              (!image.width || !image.height) &&
              image.dimensionStatus !== "unavailable" &&
              image.previewUrl &&
              image.previewUrl !== image.url
            ) {
              probeFullImageDimensions(image, generation);
            } else {
              updateImageMetas(image.url);
            }
            continue;
          }

          const visible = visibleDimensionRows.get(image.url);
          if (visible && visible.row === row && visible.generation === generation) {
            visibleDimensionRows.delete(image.url);
          }
          const cancelled = dimensionProbeScheduler.cancelQueued(
            (url, context) => url === image.url && context && context.generation === generation
          );
          for (const url of cancelled) {
            resetCancelledDimensionStatus(url);
          }
        }
        dimensionProbeScheduler.pump();
      }, { root: list, rootMargin: "0px", threshold: 0.01 });
      dimensionObserver = nextDimensionObserver;
    } else {
      thumbnailObserver = null;
      dimensionObserver = null;
    }
    elements["image-list"].replaceChildren();
    const visible = filteredImages();
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const ignoredCount = state.images.filter(isImageIgnored).length;
      if (state.showIgnored) {
        empty.textContent = ignoredCount
          ? "No ignored images match this filter."
          : state.ignoredKeys.size
            ? `No ignored images are present on this page. Use Restore all to clear the ${state.ignoredKeys.size.toLocaleString()} stored site rule${state.ignoredKeys.size === 1 ? "" : "s"}.`
            : "No ignored images are present on this page.";
      } else if (state.images.length && ignoredCount === state.images.length) {
        empty.textContent = `All ${ignoredCount.toLocaleString()} images on this page are ignored. Open the Ignored view to restore any of them.`;
      } else {
        empty.textContent = state.images.length
          ? "No images match this filter."
          : "No downloadable images were found in the loaded page.";
      }
      elements["image-list"].appendChild(empty);
      updateSummary();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const image of visible.slice(0, MAX_RENDERED_ROWS)) {
      fragment.appendChild(makeImageRow(image));
    }
    elements["image-list"].appendChild(fragment);

    if (visible.length > MAX_RENDERED_ROWS) {
      const note = document.createElement("div");
      note.className = "empty-state";
      note.textContent = state.showIgnored
        ? `Showing the first ${MAX_RENDERED_ROWS.toLocaleString()} of ${visible.length.toLocaleString()} ignored matches.`
        : `Showing the first ${MAX_RENDERED_ROWS.toLocaleString()} matches. All ${visible.length.toLocaleString()} remain available for bulk selection.`;
      elements["image-list"].appendChild(note);
    }
    updateSummary();
  }

  async function scanPage() {
    state.busy = true;
    state.images = [];
    state.selected.clear();
    state.showIgnored = false;
    state.siteKey = "";
    state.ignoredKeys.clear();
    elements["image-list"].replaceChildren();
    elements["page-label"].textContent = "Scanning the current page…";
    setNotice("");
    updateSummary();

    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || typeof tab.id !== "number") {
        throw new Error("No active page was found.");
      }
      state.incognito = Boolean(tab.incognito);
      state.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;

      const args = [{
        includeBackgrounds: elements["backgrounds-input"].checked,
        maxImages: MAX_DISCOVERED_IMAGES,
        maxElements: MAX_SCANNED_ELEMENTS,
        maxDataUrlLength: 500000,
        maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH
      }];
      let injectionResults;
      let usedFrameFallback = false;
      try {
        injectionResults = await browser.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: collectImagesFromPage,
          args
        });
      } catch (_frameError) {
        usedFrameFallback = true;
        injectionResults = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: collectImagesFromPage,
          args
        });
      }

      const merged = mergeScanResults(injectionResults);
      if (!merged.page) {
        throw new Error("The page did not return scan results.");
      }
      if (usedFrameFallback) {
        merged.warnings.push("Some embedded frames could not be inspected; the main page was scanned.");
      }

      state.siteKey = Core.siteKeyForUrl(merged.page.pageUrl);
      try {
        await loadIgnoredKeys();
      } catch (error) {
        state.ignoredKeys.clear();
        merged.warnings.push(`Firefox could not load ignored-image rules: ${error.message || error}`);
      }
      state.images = merged.images;
      state.selected = new Set(
        merged.images.filter((image) => !isImageIgnored(image)).map((image) => image.url)
      );
      state.scanWarnings = merged.warnings;
      const hostname = hostFromUrl(merged.page.pageUrl);
      elements["page-label"].textContent = merged.page.pageTitle || hostname;

      if (!state.hasStoredFolder) {
        const safeHost = Core.sanitizePathSegment(hostname, "page");
        elements["folder-input"].value = `${Core.DEFAULT_FOLDER}/${safeHost}`;
      }

      if (merged.warnings.length) {
        setNotice(merged.warnings.join(" "));
      } else if (!merged.images.length) {
        setNotice("Try scrolling to load lazy images, then scan again.");
      }
    } catch (error) {
      state.images = [];
      state.selected.clear();
      state.siteKey = "";
      state.ignoredKeys.clear();
      state.windowId = null;
      elements["page-label"].textContent = "This page cannot be scanned";
      const message = error && error.message ? error.message : String(error);
      setNotice(
        `Firefox blocks scanning on internal pages, its PDF viewer, and protected Mozilla pages. Open a normal website and try again. (${message})`,
        "error"
      );
    } finally {
      state.busy = false;
      renderImages();
    }
  }

  async function requestDownloads(images) {
    images = images.filter((image) => !isImageIgnored(image));
    if (state.busy || !images.length) {
      if (!state.busy) {
        setNotice("No non-ignored images are selected.", "error");
      }
      return;
    }
    const folder = folderStatus();
    if (!folder.ok) {
      elements["folder-input"].focus();
      updateSummary();
      return;
    }

    state.busy = true;
    setNotice(`Starting ${images.length.toLocaleString()} download${images.length === 1 ? "" : "s"}…`);
    renderImages();

    try {
      const storedSettings = {
        askForSingle: elements["ask-single-input"].checked,
        includeBackgrounds: elements["backgrounds-input"].checked
      };
      if (!state.incognito) {
        storedSettings.destinationFolder = folder.value;
      }
      await browser.storage.local.set(storedSettings);
      await loadIgnoredKeys();
      for (const image of state.images) {
        if (isImageIgnored(image)) {
          state.selected.delete(image.url);
        }
      }
      images = images.filter((image) => !isImageIgnored(image));
      if (!images.length) {
        setNotice("No non-ignored images are selected.", "error");
        return;
      }
      state.hasStoredFolder = true;
      const result = await browser.runtime.sendMessage({
        type: "DOWNLOAD_BATCH",
        folder: folder.value,
        saveAs: elements["ask-single-input"].checked && images.length === 1,
        incognito: state.incognito,
        items: images.map((image) => ({ url: image.url }))
      });

      if (!result || !result.ok) {
        const firstError = result && result.errors && result.errors[0] && result.errors[0].error;
        throw new Error((result && result.error) || firstError || "Firefox did not start the downloads.");
      }

      const firstError = result.errors && result.errors[0] ? ` First problem: ${result.errors[0].error}` : "";
      const message = result.failed
        ? `Started ${result.started.toLocaleString()} of ${result.total.toLocaleString()} downloads. ${result.failed.toLocaleString()} could not be started.${firstError}`
        : `Started ${result.started.toLocaleString()} download${result.started === 1 ? "" : "s"} in Downloads/${result.folder}.`;
      setNotice(message, result.failed ? "error" : "success");
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      state.busy = false;
      renderImages();
    }
  }

  function wireEvents() {
    elements["rescan-button"].addEventListener("click", scanPage);
    elements["filter-input"].addEventListener("input", renderImages);
    elements["folder-input"].addEventListener("input", updateSummary);
    elements["folder-input"].addEventListener("change", async () => {
      const folder = folderStatus();
      if (folder.ok) {
        elements["folder-input"].value = folder.value;
        state.hasStoredFolder = true;
        if (!state.incognito) {
          await browser.storage.local.set({ destinationFolder: folder.value });
        }
      }
      updateSummary();
    });
    elements["ask-single-input"].addEventListener("change", () => {
      browser.storage.local.set({ askForSingle: elements["ask-single-input"].checked });
    });
    elements["backgrounds-input"].addEventListener("change", () => {
      browser.storage.local.set({ includeBackgrounds: elements["backgrounds-input"].checked });
    });
    elements["ignored-button"].addEventListener("click", () => {
      state.showIgnored = !state.showIgnored;
      renderImages();
    });
    elements["clear-ignored-button"].addEventListener("click", restoreAllIgnoredImages);
    elements["select-all-button"].addEventListener("click", () => {
      state.selected = new Set(filteredImages().map((image) => image.url));
      renderImages();
    });
    elements["select-none-button"].addEventListener("click", () => {
      if (elements["filter-input"].value.trim()) {
        for (const image of filteredImages()) {
          state.selected.delete(image.url);
        }
      } else {
        state.selected.clear();
      }
      renderImages();
    });
    elements["download-button"].addEventListener("click", () => {
      const images = state.images.filter(
        (image) => state.selected.has(image.url) && !isImageIgnored(image)
      );
      requestDownloads(images);
    });
  }

  async function initialize() {
    cacheElements();
    wireEvents();
    browser.storage.onChanged.addListener(handleIgnoredStorageChanges);
    try {
      const stored = await browser.storage.local.get([
        "destinationFolder",
        "askForSingle",
        "includeBackgrounds"
      ]);
      if (stored.destinationFolder) {
        elements["folder-input"].value = stored.destinationFolder;
        state.hasStoredFolder = true;
      }
      elements["ask-single-input"].checked = Boolean(stored.askForSingle);
      elements["backgrounds-input"].checked = stored.includeBackgrounds !== false;
    } catch (_error) {
      // Defaults are sufficient if storage is unavailable.
    }
    try {
      const platform = await browser.runtime.getPlatformInfo();
      if (platform.os === "android") {
        elements["ask-single-input"].checked = false;
        elements["ask-single-input"].disabled = true;
        elements["ask-single-input"].closest("label").title = "Firefox for Android does not support the Save As option.";
      }
    } catch (_error) {
      // Platform detection only changes the optional Save As control.
    }
    await scanPage();
  }

  document.addEventListener("DOMContentLoaded", initialize, { once: true });
  })();
})(globalThis);
