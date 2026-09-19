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

  function sourceTabIdFromUrl(urlValue) {
    try {
      const value = new URL(String(urlValue || "")).searchParams.get("sourceTabId");
      if (!/^\d+$/.test(value || "")) {
        return null;
      }
      const tabId = Number(value);
      return Number.isSafeInteger(tabId) ? tabId : null;
    } catch (_error) {
      return null;
    }
  }

  function launchOptionsFromUrl(urlValue) {
    try {
      const params = new URL(String(urlValue || "")).searchParams;
      return { sidebar: params.get("sidebar") === "1" };
    } catch (_error) {
      return { sidebar: false };
    }
  }

  function collectLiveGalleryFingerprint(options) {
    "use strict";

    const maxElements = Math.max(100, Math.min(5000, Number(options && options.maxElements) || 2500));
    const selector = [
      "img",
      "picture source",
      "svg image",
      "video",
      "video source",
      "input[type='image']",
      "a[data-full]",
      "a[data-original]",
      "a[data-image]",
      "a[download]",
      "a[type^='video/' i]",
      "a[type='application/mp4' i]",
      "a[type='application/ogg' i]",
      "a[type='application/webm' i]",
      "a[type='application/x-matroska' i]",
      "a[href$='.jpg' i]",
      "a[href$='.jpeg' i]",
      "a[href$='.png' i]",
      "a[href$='.webp' i]",
      "a[href$='.avif' i]",
      "a[href$='.mp4' i]",
      "a[href$='.webm' i]",
      "a[href$='.ogv' i]",
      "a[href$='.ogg' i]",
      "a[href$='.mov' i]",
      "a[href$='.m4v' i]",
      "a[href$='.mkv' i]",
      "[data-src]",
      "[data-srcset]",
      "[data-original]",
      "[data-full]",
      "[style*='url']"
    ].join(",");
    const attributes = [
      "src", "currentSrc", "srcset", "href", "type", "download", "poster", "data-src", "data-srcset",
      "data-lazy-src", "data-original", "data-original-src", "data-full", "data-full-src", "data-large",
      "data-zoom-image", "style", "class", "width", "height"
    ];
    let hash = 2166136261;
    let count = 0;

    function add(value) {
      const text = String(value == null ? "" : value).slice(0, 4096);
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      hash ^= 31;
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    add(document.URL);
    add(document.images ? document.images.length : 0);
    try {
      add(document.querySelectorAll("video").length);
    } catch (_error) {
      add(0);
    }
    add(document.documentElement ? document.documentElement.scrollHeight : 0);
    add(document.documentElement ? document.documentElement.scrollWidth : 0);

    let nodes = [];
    try {
      nodes = document.querySelectorAll(selector);
    } catch (_error) {
      nodes = [];
    }
    const limit = Math.min(nodes.length, maxElements);
    for (let index = 0; index < limit; index += 1) {
      const node = nodes[index];
      add(node.localName || "");
      for (const attribute of attributes) {
        let value = "";
        try {
          value = attribute === "currentSrc"
            ? node.currentSrc
            : node.getAttribute && node.getAttribute(attribute);
        } catch (_error) {
          value = "";
        }
        if (value) {
          add(attribute);
          add(value);
        }
      }
      try {
        const linkedOriginal = node.closest && node.closest("a[href]");
        if (linkedOriginal) {
          add("linked-original");
          add(linkedOriginal.getAttribute("href"));
        }
      } catch (_error) {
        // The direct image attributes still provide a stable fingerprint.
      }
      count += 1;
    }

    return {
      fingerprint: `${nodes.length}:${count}:${hash.toString(16).padStart(8, "0")}`,
      pageUrl: String(document.URL || "").slice(0, 16384)
    };
  }

  function normalizedInstagramCollections(value) {
    const collections = [];
    const seen = new Set();
    for (const raw of Array.isArray(value) ? value : []) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const type = ["post", "story", "highlight"].includes(String(raw.type || ""))
        ? String(raw.type)
        : "";
      const id = String(raw.id || "").slice(0, 120);
      if (!type || !id) {
        continue;
      }
      const title = String(raw.title || "").slice(0, 120);
      const owner = String(raw.owner || "").slice(0, 80).toLowerCase();
      const key = `${type}:${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      collections.push({ type, id, title, owner });
      if (collections.length >= 32) {
        break;
      }
    }
    return collections;
  }

  function mergeInstagramCollections(left, right) {
    return normalizedInstagramCollections([
      ...normalizedInstagramCollections(left),
      ...normalizedInstagramCollections(right)
    ]);
  }

  function matchesInstagramCollectionFilter(image, filterValue) {
    const filter = String(filterValue || "all");
    if (filter === "all") {
      return true;
    }
    const collections = normalizedInstagramCollections(image && image.instagramCollections);
    if (filter === "posts") {
      return collections.some((collection) => collection.type === "post");
    }
    if (filter === "story") {
      return collections.some((collection) => collection.type === "story");
    }
    if (filter === "highlights") {
      return collections.some((collection) => collection.type === "highlight");
    }
    if (filter.startsWith("highlight:")) {
      const highlightId = filter.slice("highlight:".length);
      return Boolean(highlightId) && collections.some((collection) =>
        collection.type === "highlight" && collection.id === highlightId
      );
    }
    return false;
  }

  function canRetainSameInstagramRoute(currentScopeKey, nextScopeKey, isLoading) {
    const current = String(currentScopeKey || "");
    const next = String(nextScopeKey || "");
    return !isLoading && Boolean(current) && current === next &&
      current.startsWith("instagram:");
  }

  const VOLATILE_MEDIA_QUERY_PARAM = new RegExp([
    "^(?:",
    "x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders)|",
    "x-goog-(?:algorithm|credential|date|expires|signature|signedheaders)|",
    "expires?|expiry|exp|signature|sig|policy|key-pair-id|",
    "auth(?:entication)?|access[_-]?token|session[_-]?token|token|",
    "utm_[a-z0-9_]+|fbclid|gclid|dclid|_?cb|cache(?:buster)?|timestamp",
    ")$"
  ].join(""), "i");
  const mediaIdentityCache = new WeakMap();

  function normalizedMediaIdentity(value) {
    return String(value == null ? "" : value)
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 300);
  }

  function mediaIdentityKey(image) {
    const cacheable = Boolean(image) && (typeof image === "object" || typeof image === "function");
    const explicit = normalizedMediaIdentity(image && image.identityKey);
    const cached = cacheable ? mediaIdentityCache.get(image) : null;
    if (explicit) {
      if (cached && cached.identityKey === explicit) {
        return cached.key;
      }
      const key = `identity:${explicit}`;
      if (cacheable) {
        mediaIdentityCache.set(image, { identityKey: explicit, url: "", key });
      }
      return key;
    }

    const value = String(image && image.url || "");
    if (cached && !cached.identityKey && cached.url === value) {
      return cached.key;
    }

    let key;
    if (!value || /^data:/i.test(value)) {
      key = `url:${value}`;
    } else {
      try {
        const parsed = new URL(value);
        const stableParameters = [];
        for (const [name, parameterValue] of parsed.searchParams) {
          // Signed CDN URLs often rotate these credentials while continuing to
          // address the same media path. Keep all transform/content parameters
          // intact so distinct responsive or cropped assets stay separate.
          if (VOLATILE_MEDIA_QUERY_PARAM.test(name)) {
            continue;
          }
          stableParameters.push([name, parameterValue]);
        }
        stableParameters.sort(([leftName, leftValue], [rightName, rightValue]) =>
          leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
        );
        parsed.search = "";
        for (const [name, parameterValue] of stableParameters) {
          parsed.searchParams.append(name, parameterValue);
        }
        parsed.hash = "";
        key = `url:${parsed.href}`;
      } catch (_error) {
        key = `url:${value}`;
      }
    }
    if (cacheable) {
      mediaIdentityCache.set(image, { identityKey: "", url: value, key });
    }
    return key;
  }

  function mergeMediaRecord(existing, incoming) {
    if (!existing) {
      return incoming;
    }
    if (!incoming) {
      return existing;
    }
    const photo = incoming.originalMediaType === 1 ? incoming : existing.originalMediaType === 1 ? existing : null;
    return Object.assign({}, existing, incoming, photo, photo ? {
      mimeType: photo.mimeType || "", filename: photo.filename || "", duration: 0
    } : null, {
      identityKey: normalizedMediaIdentity(incoming.identityKey) ||
        normalizedMediaIdentity(existing.identityKey),
      previewUrl: photo ? photo.previewUrl || "" : incoming.previewUrl || existing.previewUrl || "",
      alt: incoming.alt || existing.alt || "",
      width: photo ? Number(photo.width) || 0 : Math.max(Number(existing.width) || 0, Number(incoming.width) || 0),
      height: photo ? Number(photo.height) || 0 : Math.max(Number(existing.height) || 0, Number(incoming.height) || 0),
      duration: photo ? 0 : Math.max(Number(existing.duration) || 0, Number(incoming.duration) || 0),
      instagramCollections: mergeInstagramCollections(
        existing.instagramCollections,
        incoming.instagramCollections
      )
    });
  }

  function accumulateLiveImages(previousImages, scannedImages, options) {
    const settings = Object.assign({ maxImages: 1500, maxPayloadLength: 2000000 }, options || {});
    const byIdentity = new Map();
    for (const image of [...(previousImages || []), ...(scannedImages || [])]) {
      if (image && typeof image.url === "string" && image.url) {
        const key = mediaIdentityKey(image);
        byIdentity.set(key, mergeMediaRecord(byIdentity.get(key), image));
      }
    }

    const images = [];
    let payloadLength = 0;
    for (const image of byIdentity.values()) {
      const imageLength = image.url.length + String(image.previewUrl || "").length;
      if (
        images.length >= settings.maxImages ||
        payloadLength + imageLength > settings.maxPayloadLength
      ) {
        continue;
      }
      images.push(image);
      payloadLength += imageLength;
    }
    return { images, trimmed: images.length < byIdentity.size };
  }

  function reconcileScanSelection(nextImages, previousImages, previousSelected, preserve, isEligible) {
    const previousByIdentity = new Map();
    for (const image of previousImages || []) {
      if (image && typeof image.url === "string" && image.url) {
        previousByIdentity.set(mediaIdentityKey(image), image);
      }
    }
    const selectedBefore = previousSelected instanceof Set
      ? previousSelected
      : new Set(previousSelected || []);
    const eligible = typeof isEligible === "function" ? isEligible : () => true;
    const selected = new Set();
    for (const image of nextImages || []) {
      if (!image || typeof image.url !== "string" || !eligible(image)) {
        continue;
      }
      const previous = previousByIdentity.get(mediaIdentityKey(image));
      if (!preserve || !previous || selectedBefore.has(previous.url)) {
        selected.add(image.url);
      }
    }
    return selected;
  }

  function hostPermissionPatternsForImages(images) {
    const patterns = new Set();
    for (const image of images || []) {
      const value = typeof image === "string" ? image : image && image.url;
      try {
        const url = new URL(String(value || ""));
        if (url.protocol === "http:" || url.protocol === "https:") {
          // Firefox match patterns do not include ports. A host grant covers
          // that hostname on every port for the requested scheme.
          patterns.add(`${url.protocol}//${url.hostname}/*`);
        }
      } catch (_error) {
        // Invalid and embedded URLs do not create host-permission requests.
      }
    }
    return Array.from(patterns).sort();
  }

  function downloadBatchNotice(result) {
    const queuedValue = Number(result && result.queued);
    if (!Number.isFinite(queuedValue)) {
      return null;
    }
    const queued = Math.max(0, Math.floor(queuedValue));
    const failed = Math.max(0, Math.floor(Number(result && result.failed) || 0));
    const total = Math.max(queued + failed, Math.floor(Number(result && result.total) || 0));
    const firstError = result && Array.isArray(result.errors) && result.errors[0] &&
      typeof result.errors[0].error === "string"
      ? result.errors[0].error
      : "";
    if (failed > 0) {
      const problem = firstError ? ` First problem: ${firstError}` : "";
      return {
        type: "error",
        message: `Added ${queued.toLocaleString()} of ${total.toLocaleString()} downloads to the queue. ${failed.toLocaleString()} could not be queued.${problem}`
      };
    }
    return {
      type: "success",
      message: `Added ${queued.toLocaleString()} download${queued === 1 ? "" : "s"} to the queue. Open Downloads to monitor progress.`
    };
  }

  function renderFilenameBatch(images, filenameForImage) {
    if (typeof filenameForImage !== "function") {
      throw new TypeError("filenameForImage must be a function.");
    }
    const usedNames = new Set();
    return (Array.isArray(images) ? images : []).map((image, index) => ({
      url: image && typeof image.url === "string" ? image.url : "",
      filename: filenameForImage(image, index, usedNames),
      mediaType: image && image.mediaType === "video" ? "video" : "image",
      identityKey: normalizedMediaIdentity(image && image.identityKey)
    }));
  }

  if (typeof module === "object" && module && module.exports) {
    module.exports = {
      accumulateLiveImages,
      collectLiveGalleryFingerprint,
      createDimensionProbeScheduler,
      downloadBatchNotice,
      hostPermissionPatternsForImages,
      launchOptionsFromUrl,
      canRetainSameInstagramRoute,
      mediaIdentityKey,
      matchesInstagramCollectionFilter,
      mergeInstagramCollections,
      reconcileScanSelection,
      renderFilenameBatch,
      sourceTabIdFromUrl
    };
    return;
  }

  (function initializePopup() {
    "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const collectImagesFromPage = globalThis.ImageDownloaderCollector;
  const FapFolder = globalThis.AnyDownloadFapFolder;
  const collectFapFolderMediaFromPage = globalThis.AnyDownloadFapFolderCollector ||
    FapFolder && FapFolder.collectFromPage;
  const Instagram = globalThis.ImageDownloaderInstagram;
  const collectInstagramMediaFromPage = Instagram && Instagram.collectFromPage;
  const YouTube = globalThis.AnyDownloadYouTube;
  const collectYouTubeMediaFromPage = globalThis.AnyDownloadYouTubeCollector ||
    YouTube && YouTube.collectYouTubeMediaFromPage;
  const Filters = globalThis.ImageDownloaderFilters;
  const Templates = globalThis.ImageDownloaderTemplates;
  const Gallery = globalThis.AnyDownloadGallery;
  const Tracker = globalThis.AnyDownloadTracker;
  const MAX_DISCOVERED_IMAGES = Core.MAX_BATCH_SIZE;
  const MAX_SCANNED_ELEMENTS = 10000;
  const MAX_RENDERED_ROWS = 350;
  const MAX_DIMENSION_PROBE_CONCURRENCY = 3;
  const DIMENSION_PROBE_TIMEOUT_MS = 15000;
  const MAX_IGNORED_PER_SITE = 500;
  const MAX_IGNORED_RULES = 5000;
  const IGNORE_STORAGE_PREFIX = "ignoredImage:";
  const LIVE_CAPTURE_INTERVAL_MS = 1600;
  const LIVE_RETRY_INTERVAL_MS = 4000;
  const LIVE_FORCE_SCAN_MS = 12000;
  const SIDEBAR_SCAN_DEBOUNCE_MS = 140;
  const FILTER_RENDER_DEBOUNCE_MS = 90;
  const SIDEBAR_ALL_URLS_PERMISSION = Object.freeze({ origins: ["<all_urls>"] });
  const launchUrl = globalScope.location && globalScope.location.href;
  const launchSourceTabId = sourceTabIdFromUrl(launchUrl);
  const launchOptions = launchOptionsFromUrl(launchUrl);
  const managerTabMode = Number.isInteger(launchSourceTabId);
  const sidebarMode = launchOptions.sidebar;
  const editTrackerId = new URL(launchUrl).searchParams.get("editTrackerId");
  const responsiveSurface = managerTabMode || sidebarMode || Boolean(editTrackerId);

  if (sidebarMode) {
    document.documentElement.classList.add("sidebar-panel");
  }
  if (responsiveSurface) {
    document.documentElement.classList.add("responsive-surface");
  }
  if (globalScope.parent?.AnyDownloadWorkspace && new URL(launchUrl).searchParams.get("embedded") === "1") {
    document.documentElement.classList.add("embedded-workspace");
  }

  let filenamePreviewsDirty = true;
  let filenamePreviewDateKey = "";
  let filenamePreviewTemplateValue = "";
  let filterRenderTimer = null;

  class TrackedSelectionSet extends Set {
    add(value) {
      const existed = this.has(value);
      super.add(value);
      if (!existed) {
        markFilenamePreviewsDirty();
      }
      return this;
    }

    delete(value) {
      const deleted = super.delete(value);
      if (deleted) {
        markFilenamePreviewsDirty();
      }
      return deleted;
    }

    clear() {
      if (this.size) {
        super.clear();
        markFilenamePreviewsDirty();
      }
    }
  }

  const state = {
    workspace: "media",
    images: [],
    showSelected: false,
    galleryPage: 0,
    sort: "page",
    selected: new TrackedSelectionSet(),
    scanWarnings: [],
    busy: false,
    hasStoredFolder: false,
    hideDownloaded: false,
    incognito: true,
    ignoredKeys: new Set(),
    explicitRedownloads: new Set(),
    filenameTemplate: Templates.DEFAULT_TEMPLATE,
    filenamePreviewByUrl: new Map(),
    instagramCollectionMode: false,
    instagramCollectionFilter: "all",
    liveCapture: false,
    liveScanning: false,
    pageScopeKey: "",
    pageTitle: "",
    pageUrl: "",
    showIgnored: false,
    siteKey: "",
    sidebarHasBroadAccess: false,
    sidebarPermissionNeeded: false,
    sidebarWindowId: null,
    smartFilters: Filters.normalizeFilters(),
    sourceWindowId: null,
    sourceTabId: launchSourceTabId,
    tracker: null,
    trackerBusy: false,
    trackerPageUrl: ""
  };

  const elements = {};
  const ignoredKeyByImage = new WeakMap();
  const renderedMetaNodes = new Map();
  const renderedNameNodes = new Map();
  const visibleDimensionRows = new Map();
  let thumbnailObserver = null;
  let dimensionObserver = null;
  let downloadStatusGeneration = 0;
  let downloadStatusRefreshTimer = null;
  let ignoreWriteQueue = Promise.resolve();
  let indexedImages = null;
  let imageByUrl = new Map();
  let liveCaptureTimer = null;
  let liveCaptureGeneration = 0;
  let liveFingerprint = "";
  let liveLastFullScanAt = 0;
  let liveRetryNoticeText = "";
  let queueBadgeGeneration = 0;
  let queueBadgePollingStopped = false;
  let queueBadgeTimer = null;
  let renderGeneration = 0;
  let sidebarFollowGeneration = 0;
  let sourcePageGeneration = 0;
  let sidebarFollowTimer = null;
  let sidebarFollowRequest = null;
  let sidebarFollowRunning = false;
  let smartFilterRefreshTimer = null;
  let galleryContext = null;
  let gallerySaveTimer = null;
  let galleryWritePromise = Promise.resolve();
  let galleryCollection = null;
  let sourceRescanTimer = null;
  let clearedGallery = null;
  let previewItems = [];
  let previewIndex = 0;
  let previewOpener = null;

  function markFilenamePreviewsDirty() {
    filenamePreviewsDirty = true;
  }

  function filenamePreviewDateKeyFor(date) {
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join("-");
  }

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
      "media-workspace", "workspace-frame", "media-button",
      "gallery-undo", "undo-clear-button",
      "editor-source-link",
      "gallery-pagination", "previous-page-button", "next-page-button", "pagination-label",
      "min-width-input", "min-height-input", "orientation-filter-select", "sort-select",
      "selection-warning", "back-to-collection-button",
      "media-preview-dialog", "media-preview-title", "media-preview-stage", "media-preview-meta",
      "media-preview-error", "media-preview-position", "close-preview-button",
      "preview-previous-button", "preview-next-button", "preview-selected-input", "preview-selected-text",
      "preview-download-button", "preview-tab-button", "preview-source-link",
      "action-detail",
      "archive-footer-button",
      "upload-button", "integrations-button",
      "ask-single-input",
      "backgrounds-input",
      "clear-ignored-button",
      "clear-gallery-button",
      "collect-gallery-button",
      "refresh-media-button",
      "stop-gallery-button",
      "gallery-status",
      "download-button",
      "download-settings-panel",
      "download-settings-button",
      "downloaded-button",
      "filter-input",
      "filename-template-button",
      "filename-template-help",
      "filename-template-input",
      "filename-template-panel",
      "filename-template-preview",
      "format-filter-select",
      "folder-help",
      "folder-input",
      "history-button",
      "grid-view-button",
      "list-view-button",
      "ignored-button",
      "image-list",
      "instagram-collection-filter-field",
      "instagram-collection-filter-select",
      "instagram-collections-button",
      "media-type-filter-select",
      "notice",
      "page-label",
      "photos-only-input",
      "queue-badge",
      "reset-filters-button",
      "select-all-button",
      "select-none-button",
      "selected-label",
      "sidebar-follow-button",
      "smart-filter-panel",
      "smart-filters-button",
      "summary-label",
      "sync-button",
      "tracking-dashboard-button",
      "tracker-button",
      "tracker-action-select",
      "tracker-delete-button",
      "tracker-download-initial-input",
      "tracker-exclude-patterns-input",
      "tracker-exclude-text-input",
      "tracker-include-patterns-input",
      "tracker-include-text-input",
      "tracker-interval-select",
      "tracker-max-downloads-select",
      "tracker-max-pages-field",
      "tracker-max-pages-select",
      "tracker-next-selector-field",
      "tracker-next-selector-input",
      "tracker-notify-errors-input",
      "tracker-notify-matches-input",
      "tracker-pagination-mode-select",
      "tracker-panel",
      "tracker-pause-button",
      "tracker-run-button",
      "tracker-save-button",
      "tracker-state-label",
      "tracker-status",
      "tracker-url-template-field",
      "tracker-url-template-input"
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

  function trackerPermissionPattern(pageUrl) {
    try {
      const parsed = new URL(String(pageUrl || ""));
      return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname
        ? `${parsed.protocol}//${parsed.hostname}/*`
        : "";
    } catch (_error) {
      return "";
    }
  }

  function formatTrackerTime(value) {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) {
      return "not checked yet";
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(time));
  }

  function setTrackerBusy(busy, status) {
    state.trackerBusy = Boolean(busy);
    for (const id of [
      "tracker-save-button",
      "tracker-run-button",
      "tracker-pause-button",
      "tracker-delete-button",
      "tracker-action-select",
      "tracker-interval-select",
      "tracker-download-initial-input",
      "tracker-exclude-patterns-input",
      "tracker-exclude-text-input",
      "tracker-include-patterns-input",
      "tracker-include-text-input",
      "tracker-max-downloads-select",
      "tracker-max-pages-select",
      "tracker-next-selector-input",
      "tracker-notify-errors-input",
      "tracker-notify-matches-input",
      "tracker-pagination-mode-select",
      "tracker-url-template-input"
    ]) {
      elements[id].disabled = state.trackerBusy;
    }
    elements["tracker-button"].disabled = state.trackerBusy || state.incognito || !state.pageUrl;
    updateTrackerActionFields();
    if (status) {
      elements["tracker-status"].textContent = status;
      elements["tracker-status"].classList.remove("error");
    }
  }

  function updateTrackerPaginationFields() {
    const mode = elements["tracker-pagination-mode-select"].value;
    elements["tracker-max-pages-field"].hidden = mode === "none";
    elements["tracker-next-selector-field"].hidden = mode !== "next-link";
    elements["tracker-url-template-field"].hidden = mode !== "url-template";
  }

  function updateTrackerActionFields() {
    const notifyOnly = elements["tracker-action-select"].value === "notify";
    if (notifyOnly) {
      elements["tracker-notify-matches-input"].checked = true;
    }
    elements["tracker-notify-matches-input"].disabled = state.trackerBusy ||
      state.incognito || !state.pageUrl || notifyOnly;
  }

  function populateTrackerControls(tracker) {
    const matching = tracker && tracker.matching || {};
    const pagination = tracker && tracker.pagination || {};
    const notifications = tracker && tracker.notifications || {};
    elements["tracker-include-text-input"].value = matching.includeText == null
      ? elements["filter-input"].value.trim()
      : matching.includeText;
    elements["tracker-exclude-text-input"].value = matching.excludeText || "";
    elements["tracker-include-patterns-input"].value = Array.isArray(matching.includePatterns)
      ? matching.includePatterns.join("\n")
      : "";
    elements["tracker-exclude-patterns-input"].value = Array.isArray(matching.excludePatterns)
      ? matching.excludePatterns.join("\n")
      : "";
    elements["tracker-max-downloads-select"].value = String(matching.maxDownloadsPerRun || 100);
    elements["tracker-pagination-mode-select"].value = pagination.mode || "none";
    elements["tracker-max-pages-select"].value = String(pagination.maxPages || 3);
    elements["tracker-next-selector-input"].value = pagination.nextSelector || "";
    elements["tracker-url-template-input"].value = pagination.urlTemplate || "";
    elements["tracker-action-select"].value = tracker && tracker.action || "review";
    elements["tracker-notify-matches-input"].checked = notifications.newMatches !== false;
    elements["tracker-notify-errors-input"].checked = notifications.errors !== false;
    updateTrackerPaginationFields();
    updateTrackerActionFields();
  }

  function updateTrackerUi() {
    const tracker = state.tracker;
    const available = Boolean(state.pageUrl) && !state.incognito;
    elements["tracker-button"].disabled = state.trackerBusy || !available;
    elements["tracking-dashboard-button"].disabled = state.incognito;
    elements["tracker-button"].classList.toggle("active", Boolean(tracker));
    elements["tracker-button"].textContent = tracker ? "Tracking" : "Track page";
    elements["tracker-button"].title = state.incognito
      ? "Background trackers are unavailable in private windows"
      : "Check this URL regularly and notify, review, or download newly discovered matches";
    for (const id of [
      "tracker-save-button",
      "tracker-run-button",
      "tracker-pause-button",
      "tracker-delete-button",
      "tracker-action-select",
      "tracker-interval-select",
      "tracker-exclude-patterns-input",
      "tracker-exclude-text-input",
      "tracker-include-patterns-input",
      "tracker-include-text-input",
      "tracker-max-downloads-select",
      "tracker-max-pages-select",
      "tracker-next-selector-input",
      "tracker-notify-errors-input",
      "tracker-notify-matches-input",
      "tracker-pagination-mode-select",
      "tracker-url-template-input"
    ]) {
      elements[id].disabled = state.trackerBusy || !available;
    }

    elements["tracker-state-label"].textContent = tracker
      ? tracker.enabled ? "Active" : "Paused"
      : state.incognito ? "Unavailable in private windows" : "Not active";
    elements["tracker-save-button"].textContent = tracker ? "Update tracker" : "Start tracking";
    elements["tracker-run-button"].hidden = !tracker;
    elements["tracker-pause-button"].hidden = !tracker;
    elements["tracker-delete-button"].hidden = !tracker;
    elements["tracker-pause-button"].textContent = tracker && tracker.enabled ? "Pause" : "Resume";
    updateTrackerActionFields();

    if (tracker) {
      const interval = String(tracker.intervalMinutes || 60);
      if (Array.from(elements["tracker-interval-select"].options).some((option) => option.value === interval)) {
        elements["tracker-interval-select"].value = interval;
      }
      elements["tracker-download-initial-input"].checked = Boolean(tracker.downloadInitial);
      elements["tracker-download-initial-input"].disabled = state.trackerBusy || !available || Boolean(tracker.initialized);
      elements["tracker-status"].classList.toggle("error", Boolean(tracker.lastError));
      if (tracker.lastError) {
        const reliability = tracker.autoPausedReason
          ? " · Automatically paused"
          : tracker.backoffUntil > Date.now()
            ? ` · Retry after ${formatTrackerTime(tracker.backoffUntil)}`
            : "";
        elements["tracker-status"].textContent = `Last check reported an issue: ${tracker.lastError}${reliability}`;
      } else if (tracker.lastSuccessAt) {
        const actionResult = tracker.action === "review"
          ? `${Number(tracker.lastReviewed || 0).toLocaleString()} added to review · ${Number(tracker.pendingReviewCount || 0).toLocaleString()} pending`
          : tracker.action === "notify"
            ? `${Number(tracker.lastDiscovered || 0).toLocaleString()} notified · nothing queued`
            : `${Number(tracker.lastQueued || 0).toLocaleString()} queued`;
        elements["tracker-status"].textContent =
          `Checked ${formatTrackerTime(tracker.lastSuccessAt)} · ${Number(tracker.lastPagesChecked || 1).toLocaleString()} page${tracker.lastPagesChecked === 1 ? "" : "s"} · ${Number(tracker.lastFound || 0).toLocaleString()} matched · ${actionResult}.`;
      } else {
        elements["tracker-status"].textContent = "Waiting for the first check.";
      }
    } else {
      elements["tracker-download-initial-input"].disabled = state.trackerBusy || !available;
      elements["tracker-status"].classList.remove("error");
      elements["tracker-status"].textContent = state.incognito
        ? "Open this page in a regular window to create a background tracker."
        : "Start tracking to create a baseline. Current matches are skipped unless you opt in above.";
    }
  }

  async function refreshTrackerStatus(force) {
    if (!state.pageUrl || state.incognito) {
      state.tracker = null;
      state.trackerPageUrl = state.incognito ? state.pageUrl : "";
      populateTrackerControls(null);
      updateTrackerUi();
      return;
    }
    if (!force && state.trackerPageUrl === state.pageUrl) {
      updateTrackerUi();
      return;
    }
    const requestedUrl = state.pageUrl;
    const response = await browser.runtime.sendMessage({
      type: "GET_TRACKER",
      url: requestedUrl
    });
    if (requestedUrl !== state.pageUrl) {
      return;
    }
    if (!response || !response.ok) {
      throw new Error(response && response.error || "Firefox could not read the tracker state.");
    }
    state.tracker = response.tracker || null;
    state.trackerPageUrl = requestedUrl;
    populateTrackerControls(state.tracker);
    updateTrackerUi();
  }

  function trackerOutcomeNotice(tracker, saved) {
    if (!tracker) {
      return saved ? "Tracker saved." : "Tracker is up to date.";
    }
    if (tracker.action === "review" && Number(tracker.lastReviewed)) {
      return `${saved ? "Tracker saved and added" : "Added"} ${Number(tracker.lastReviewed).toLocaleString()} new match${tracker.lastReviewed === 1 ? "" : "es"} to review.`;
    }
    if (tracker.action === "notify" && Number(tracker.lastDiscovered)) {
      return `${saved ? "Tracker saved and found" : "Found"} ${Number(tracker.lastDiscovered).toLocaleString()} new match${tracker.lastDiscovered === 1 ? "" : "es"}; nothing was downloaded.`;
    }
    if (Number(tracker.lastQueued)) {
      return `${saved ? "Tracker saved and queued" : "Queued"} ${Number(tracker.lastQueued).toLocaleString()} new match${tracker.lastQueued === 1 ? "" : "es"}.`;
    }
    if (saved) {
      return tracker.action === "review"
        ? "Tracker saved. New matches will wait in Tracking for review."
        : tracker.action === "notify"
          ? "Tracker saved. New matches will trigger a notification without downloading."
          : "Tracker saved. New matches will be added to the download queue in the background.";
    }
    return "Tracker is up to date; no new matches required action.";
  }

  async function saveTracker() {
    if (state.trackerBusy || state.incognito) {
      return;
    }
    const pattern = trackerPermissionPattern(state.pageUrl);
    const folder = folderStatus();
    const template = requireValidFilenameTemplate();
    if (!pattern || !folder.ok || !template) {
      if (!pattern) {
        setNotice("This page cannot be tracked in the background.", "error");
      } else if (!folder.ok) {
        elements["download-settings-panel"].showPopover();
        elements["folder-input"].focus();
      }
      return;
    }
    const paginationMode = elements["tracker-pagination-mode-select"].value;
    const paginationTemplate = elements["tracker-url-template-input"].value.trim();
    const nextSelector = elements["tracker-next-selector-input"].value.trim();
    if (paginationMode === "next-link" && nextSelector) {
      try {
        document.querySelector(nextSelector);
      } catch (_error) {
        setNotice("The custom Next-link selector is not valid CSS.", "error");
        elements["tracker-next-selector-input"].focus();
        return;
      }
    }
    if (paginationMode === "url-template" && !paginationTemplate.includes("{page}")) {
      setNotice("The pagination URL template must contain {page}.", "error");
      elements["tracker-url-template-input"].focus();
      return;
    }
    if (paginationMode === "url-template") {
      try {
        const base = new URL(state.pageUrl);
        const candidate = new URL(paginationTemplate.split("{page}").join("2"), base);
        if (candidate.origin !== base.origin || !["http:", "https:"].includes(candidate.protocol)) {
          throw new Error("different origin");
        }
      } catch (_error) {
        setNotice("The pagination URL template must be a valid URL on the same website.", "error");
        elements["tracker-url-template-input"].focus();
        return;
      }
    }
    if (!browser.permissions || typeof browser.permissions.request !== "function") {
      setNotice("This Firefox build cannot grant the site access needed by background trackers.", "error");
      return;
    }

    let permissionPromise;
    try {
      permissionPromise = browser.permissions.request({ origins: [pattern] });
    } catch (error) {
      setNotice(`Firefox could not request access to this site. (${error.message || error})`, "error");
      return;
    }

    setTrackerBusy(true, state.tracker ? "Updating tracker…" : "Creating the first baseline…");
    try {
      if (!await permissionPromise) {
        throw new Error("Site access was not granted, so the tracker was not created.");
      }
      const filters = smartFiltersFromControls();
      const includeText = elements["tracker-include-text-input"].value.trim();
      state.smartFilters = filters;
      const response = await browser.runtime.sendMessage({
        type: "UPSERT_TRACKER",
        incognito: state.incognito,
        tracker: {
          url: state.pageUrl,
          pageTitle: state.pageTitle,
          folder: folder.value,
          intervalMinutes: Number(elements["tracker-interval-select"].value),
          filters,
          query: includeText,
          matching: {
            includeText,
            excludeText: elements["tracker-exclude-text-input"].value.trim(),
            includePatterns: elements["tracker-include-patterns-input"].value.split(/\n+/),
            excludePatterns: elements["tracker-exclude-patterns-input"].value.split(/\n+/),
            maxDownloadsPerRun: Number(elements["tracker-max-downloads-select"].value)
          },
          action: elements["tracker-action-select"].value,
          pagination: {
            mode: paginationMode,
            maxPages: Number(elements["tracker-max-pages-select"].value),
            nextSelector,
            urlTemplate: paginationTemplate
          },
          notifications: {
            newMatches: elements["tracker-action-select"].value === "notify" ||
              elements["tracker-notify-matches-input"].checked,
            errors: elements["tracker-notify-errors-input"].checked
          },
          filenameTemplate: template.value,
          downloadInitial: elements["tracker-download-initial-input"].checked
        }
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "Firefox could not save the tracker.");
      }
      state.tracker = response.tracker || null;
      state.trackerPageUrl = state.pageUrl;
      state.hasStoredFolder = true;
      populateTrackerControls(state.tracker);
      await persistSettings({
        destinationFolder: folder.value,
        filenameTemplate: template.value,
        smartFilters: filters
      });
      setNotice(
        state.tracker && state.tracker.lastError
          ? `Tracker saved, but its first check needs attention. (${state.tracker.lastError})`
          : state.tracker && !state.tracker.enabled
            ? "Tracker updated and remains paused."
          : trackerOutcomeNotice(state.tracker, true),
        state.tracker && state.tracker.lastError ? "error" : "success"
      );
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      setTrackerBusy(false);
      updateTrackerUi();
    }
  }

  async function runTrackerNow() {
    if (!state.tracker || state.trackerBusy) {
      return;
    }
    setTrackerBusy(true, "Checking the tracked page…");
    try {
      const response = await browser.runtime.sendMessage({
        type: "RUN_TRACKER",
        id: state.tracker.id
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "The tracker check failed.");
      }
      state.tracker = response.tracker;
      populateTrackerControls(state.tracker);
      setNotice(
        state.tracker.lastError
          ? `Tracker check needs attention. (${state.tracker.lastError})`
          : trackerOutcomeNotice(state.tracker, false),
        state.tracker.lastError ? "error" : "success"
      );
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      setTrackerBusy(false);
      updateTrackerUi();
    }
  }

  async function toggleTrackerEnabled() {
    if (!state.tracker || state.trackerBusy) {
      return;
    }
    const enabled = !state.tracker.enabled;
    setTrackerBusy(true, enabled ? "Resuming tracker…" : "Pausing tracker…");
    try {
      const response = await browser.runtime.sendMessage({
        type: "SET_TRACKER_ENABLED",
        id: state.tracker.id,
        enabled
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "Firefox could not update the tracker.");
      }
      state.tracker = response.tracker;
      populateTrackerControls(state.tracker);
      setNotice(enabled ? "Tracker resumed." : "Tracker paused.", "success");
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      setTrackerBusy(false);
      updateTrackerUi();
    }
  }

  async function deleteTracker() {
    if (!state.tracker || state.trackerBusy || !window.confirm("Remove this background tracker? Its pending review items will be removed; download history will be kept.")) {
      return;
    }
    setTrackerBusy(true, "Removing tracker…");
    try {
      const response = await browser.runtime.sendMessage({
        type: "DELETE_TRACKER",
        id: state.tracker.id
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "Firefox could not remove the tracker.");
      }
      state.tracker = null;
      state.trackerPageUrl = state.pageUrl;
      populateTrackerControls(null);
      setNotice("Tracker removed.", "success");
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      setTrackerBusy(false);
      updateTrackerUi();
    }
  }

  function handleTrackerStorageChanges(changes, areaName) {
    if (areaName !== "local" || !changes || !changes["mediaTrackers:v1"] || !state.pageUrl || state.incognito || state.trackerBusy) {
      return;
    }
    refreshTrackerStatus(true).catch((error) => {
      console.error("AnyDownload could not refresh its tracker state.", error);
    });
  }

  function filenameTemplateStatus() {
    return Templates.validate(elements["filename-template-input"].value);
  }

  function mediaTypeFor(image) {
    return image && image.mediaType === "video" ? "video" : "image";
  }

  function baseFilenameForMedia(image, index) {
    const inferred = (Core.filenameForMedia || Core.filenameForImage)(
      image && image.url,
      index,
      mediaTypeFor(image)
    );
    const suggested = String(image && image.filename || "").slice(0, 500).trim();
    const recognized = mediaTypeFor(image) === "video"
      ? /\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)$/i.test(suggested)
      : /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(suggested);
    return recognized ? Core.sanitizeFilename(suggested, inferred) : inferred;
  }

  function filenameMetadata(image, index, date) {
    const mediaType = mediaTypeFor(image);
    return {
      filename: baseFilenameForMedia(image, index),
      url: image && image.url,
      pageUrl: image && image.pageUrl || state.pageUrl,
      pageTitle: image && image.pageTitle || state.pageTitle,
      width: image && image.width,
      height: image && image.height,
      mimeType: image && (image.mimeType || image.type),
      mediaType,
      index: index + 1,
      date
    };
  }

  function requireValidFilenameTemplate() {
    const result = updateFilenameTemplateUi();
    if (!result.ok) {
      elements["download-settings-panel"].showPopover();
      elements["filename-template-panel"].hidden = false;
      elements["filename-template-button"].setAttribute("aria-expanded", "true");
      elements["filename-template-input"].focus();
      setNotice(result.error, "error");
      updateSummary();
      return null;
    }

    elements["filename-template-input"].value = result.value;
    state.filenameTemplate = result.value;
    return result;
  }

  function renderedDownloadItems(images, templateValue, jobDate) {
    const template = Templates.validate(
      templateValue === undefined ? elements["filename-template-input"].value : templateValue
    );
    if (!template.ok) {
      throw new Error(template.error);
    }
    const batchDate = jobDate instanceof Date ? jobDate : new Date();
    const items = renderFilenameBatch(images, (image, batchIndex, usedNames) => Templates.render(
      template.value,
      filenameMetadata(image, batchIndex, batchDate),
      { usedNames }
    ));
    return items.map((item, index) => ({ ...item, url: Gallery.youtubeUrl(images[index]) || item.url }));
  }

  function rebuildFilenamePreviews(templateResult, jobDate) {
    const result = templateResult || filenameTemplateStatus();
    const date = jobDate instanceof Date ? jobDate : new Date();
    const previews = new Map();
    if (result.ok) {
      const selected = selectedDownloadableImages();
      const rendered = renderedDownloadItems(selected, result.value, date);
      rendered.forEach((item, index) => previews.set(selected[index].url, item.filename));
      for (const image of state.images) {
        if (previews.has(image.url)) {
          continue;
        }
        const preview = Templates.preview(
          result.value,
          filenameMetadata(image, 0, date)
        );
        previews.set(
          image.url,
          preview.ok ? preview.value : baseFilenameForMedia(image, 0)
        );
      }
    } else {
      state.images.forEach((image, index) => {
        previews.set(image.url, baseFilenameForMedia(image, index));
      });
    }
    state.filenamePreviewByUrl = previews;
    filenamePreviewsDirty = false;
    filenamePreviewTemplateValue = elements["filename-template-input"].value;
    filenamePreviewDateKey = filenamePreviewDateKeyFor(date);
    return previews;
  }

  function updateFilenameTemplateUi() {
    const result = filenameTemplateStatus();
    const date = new Date();
    const currentTemplateValue = elements["filename-template-input"].value;
    const currentDateKey = filenamePreviewDateKeyFor(date);
    const previews = filenamePreviewsDirty ||
      filenamePreviewTemplateValue !== currentTemplateValue ||
      filenamePreviewDateKey !== currentDateKey
      ? rebuildFilenamePreviews(result, date)
      : state.filenamePreviewByUrl;
    const sample = firstSelectedDownloadableImage() ||
      state.images.find((image) => !isImageIgnored(image)) || {
      url: "https://example.invalid/image-0001.jpg",
      width: 1920,
      height: 1080
    };
    const mappedPreview = sample && previews.get(sample.url);
    const preview = mappedPreview
      ? { ok: true, value: mappedPreview, error: "" }
      : Templates.preview(
        elements["filename-template-input"].value,
        filenameMetadata(sample, 0, date)
      );
    elements["filename-template-preview"].textContent = preview.ok
      ? `Example: ${preview.value}`
      : "Template needs attention";
    elements["filename-template-preview"].title = preview.ok ? preview.value : preview.error;
    elements["filename-template-input"].setAttribute("aria-invalid", String(!result.ok));
    elements["filename-template-help"].classList.toggle("error", !result.ok);
    elements["filename-template-help"].textContent = result.ok
      ? "Tokens: {filename}, {name}, {ext}, {index}, {hostname}, {page-title}, {width}, {height}, {date}. The zero-padded {index} follows selected page order."
      : result.error;
    state.filenameTemplate = result.ok ? result.value : elements["filename-template-input"].value;
    return result;
  }

  function refreshRenderedFilenamePreviews() {
    markFilenamePreviewsDirty();
    updateFilenameTemplateUi();
    for (const [url, records] of renderedNameNodes) {
      const image = currentImageForUrl(url);
      if (!image) {
        renderedNameNodes.delete(url);
        continue;
      }
      const filename = friendlyFilename(image);
      for (const record of records) {
        if (!record.label.isConnected) {
          records.delete(record);
          continue;
        }
        record.label.textContent = filename;
        record.container.title = image.alt || filename;
        record.checkbox.setAttribute(
          "aria-label",
          downloadStatusFor(image) === "downloaded"
            ? `Select ${filename} to download it again`
            : `Select ${filename}`
        );
        record.previewButton.setAttribute("aria-label", `Preview ${filename}`);
      }
      if (!records.size) {
        renderedNameNodes.delete(url);
      }
    }
  }

  const workspaces = {
    media: ["media-button", "Media collection"],
    history: ["history-button", "Downloads"],
    tracking: ["tracking-dashboard-button", "Trackers"],
    sync: ["sync-button", "Account"],
    integrations: ["integrations-button", "Integrations"],
    upload: ["integrations-button", "Uploads"]
  };
  const navigationWorkspaces = ["media", "history", "tracking", "sync", "integrations"];
  const UPLOAD_ROUTE_ID = /^[a-z0-9_-]{1,128}$/i;

  function showWorkspace(view, route = "") {
    if (!Object.hasOwn(workspaces, view) ||
      state.incognito && ["tracking", "sync", "integrations", "upload"].includes(view)) return;
    const trackerId = view === "tracking" ? route : "";
    if (trackerId && (typeof trackerId !== "string" || trackerId.length > 200)) return;
    const frame = elements["workspace-frame"];
    const url = new URL(browser.runtime.getURL(trackerId ? "popup/popup.html" : `${view}/${view}.html`));
    if (view === "upload" && route) {
      if (typeof route !== "string") return;
      const requested = new URLSearchParams(route.startsWith("?") ? route.slice(1) : route);
      const requestId = requested.get("request");
      const jobId = requested.get("job");
      if (requestId && jobId || requestId && !UPLOAD_ROUTE_ID.test(requestId) || jobId && !UPLOAD_ROUTE_ID.test(jobId)) return;
      if (requestId) url.searchParams.set("request", requestId);
      if (jobId) url.searchParams.set("job", jobId);
    }
    url.searchParams.set("embedded", "1");
    if (Number.isInteger(state.sourceTabId)) url.searchParams.set("sourceTabId", state.sourceTabId);
    if (trackerId) url.searchParams.set("editTrackerId", trackerId);
    state.workspace = view;
    elements["media-workspace"].hidden = view !== "media";
    frame.hidden = view === "media";
    if (view === "media") frame.removeAttribute("src");
    else if (frame.src !== url.href) frame.src = url.href;
    frame.title = trackerId ? "Edit tracker" : workspaces[view][1];
    document.title = `AnyDownload — ${workspaces[view][1]}`;
    const navigationView = view === "upload" ? "integrations" : view;
    for (const key of navigationWorkspaces) {
      const id = workspaces[key][0];
      elements[id].classList.toggle("current", key === navigationView);
      if (key === navigationView) elements[id].setAttribute("aria-current", "page");
      else elements[id].removeAttribute("aria-current");
    }
    for (const id of ["smart-filter-panel", "download-settings-panel", "tracker-panel"]) {
      if (elements[id].matches(":popover-open")) elements[id].hidePopover();
    }
  }

  globalScope.AnyDownloadWorkspace = {
    open: showWorkspace,
    editTracker: (id) => showWorkspace("tracking", id)
  };

  async function writeNormalStorage(action, value) {
    let response;
    try {
      response = await browser.runtime.sendMessage({
        type: "CLOUD_LOCAL_WRITE", action,
        ...(action === "set" ? { values: value } : { keys: value })
      });
    } catch (_error) {
      // Keep transport failures free of account/session details.
    }
    if (!response || !response.ok) {
      throw new Error("Firefox could not save these changes. Please try again.");
    }
  }

  function persistSettings(values) {
    return Boolean(editTrackerId) || state.incognito || browser.extension && browser.extension.inIncognitoContext
      ? Promise.resolve() : writeNormalStorage("set", values);
  }

  function handleSettingsStorageChanges(changes, areaName) {
    if (areaName !== "local" || state.incognito) return;
    let changed = false;
    for (const [key, id, normalize] of [
      ["askForSingle", "ask-single-input", Boolean],
      ["includeBackgrounds", "backgrounds-input", (value) => value !== false]
    ]) {
      const change = changes[key];
      const input = elements[id];
      if (change && !input.disabled && document.activeElement !== input && input.checked === normalize(change.oldValue)) {
        input.checked = normalize(change.newValue);
        changed = true;
      }
    }
    const folder = changes.destinationFolder;
    if (folder && document.activeElement !== elements["folder-input"] &&
      (!state.hasStoredFolder || elements["folder-input"].value === folder.oldValue)) {
      elements["folder-input"].value = folder.newValue || Core.DEFAULT_FOLDER;
      state.hasStoredFolder = Boolean(folder.newValue);
      changed = true;
    }
    const template = changes.filenameTemplate;
    if (template && document.activeElement !== elements["filename-template-input"] &&
      elements["filename-template-input"].value === (template.oldValue || Templates.DEFAULT_TEMPLATE)) {
      const validated = Templates.validate(template.newValue);
      elements["filename-template-input"].value = validated.ok ? validated.value : Templates.DEFAULT_TEMPLATE;
      changed = true;
    }
    const filters = changes.smartFilters;
    if (filters && !["photos-only-input", "media-type-filter-select", "format-filter-select", "min-width-input", "min-height-input", "orientation-filter-select"].some(
      (id) => document.activeElement === elements[id]
    ) && JSON.stringify(state.smartFilters) === JSON.stringify(Filters.normalizeFilters(filters.oldValue))) {
      applySmartFiltersToControls(filters.newValue);
      changed = true;
    }
    if (changes.mediaLayout) applyMediaView(changes.mediaLayout.newValue);
    if (changed) {
      refreshRenderedFilenamePreviews();
      updateSmartFilterButton();
      renderImages();
    }
  }

  async function refreshQueueBadge() {
    const generation = ++queueBadgeGeneration;
    try {
      const response = await browser.runtime.sendMessage({
        type: "GET_DOWNLOAD_DASHBOARD",
        incognito: state.incognito,
        summaryOnly: true
      });
      if (generation !== queueBadgeGeneration) {
        return;
      }
      const summary = response && response.ok && response.snapshot && response.snapshot.summary;
      const count = (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
      };
      const active = summary && summary.active == null
        ? count(summary.starting) + count(summary.inProgress || summary.in_progress)
        : count(summary && summary.active);
      const pending = summary
        ? count(summary.queued) + active + count(summary.paused)
        : 0;
      elements["queue-badge"].textContent = pending > 99 ? "99+" : String(pending);
      elements["queue-badge"].hidden = pending < 1;
      const label = pending
        ? `${pending.toLocaleString()} download${pending === 1 ? "" : "s"} queued or active`
        : "Download queue and statistics";
      elements["history-button"].title = label;
      elements["history-button"].setAttribute(
        "aria-label",
        pending ? `Open download queue: ${label}` : "Open download queue and statistics"
      );
    } catch (_error) {
      if (generation !== queueBadgeGeneration) {
        return;
      }
      elements["queue-badge"].hidden = true;
      elements["history-button"].title = "Download queue and statistics";
      elements["history-button"].setAttribute("aria-label", "Open download queue and statistics");
    }
  }

  function startQueueBadgePolling() {
    if (queueBadgeTimer !== null) {
      return;
    }
    const tick = async () => {
      queueBadgeTimer = null;
      await refreshQueueBadge();
      if (!queueBadgePollingStopped) {
        queueBadgeTimer = setTimeout(tick, 2500);
      }
    };
    queueBadgeTimer = setTimeout(tick, 2500);
    globalThis.addEventListener("pagehide", () => {
      queueBadgePollingStopped = true;
      if (queueBadgeTimer !== null) {
        clearTimeout(queueBadgeTimer);
        queueBadgeTimer = null;
      }
      queueBadgeGeneration += 1;
    }, { once: true });
  }

  function setIncognitoContext(value) {
    const nextValue = Boolean(value || browser.extension && browser.extension.inIncognitoContext);
    elements["sync-button"].disabled = nextValue;
    elements["integrations-button"].disabled = nextValue;
    if (state.incognito === nextValue) {
      return;
    }
    state.incognito = nextValue;
    elements["workspace-frame"].removeAttribute("src");
    showWorkspace(state.workspace === "history" ? "history" : "media");
    refreshQueueBadge();
  }

  function hostFromUrl(value) {
    try {
      return new URL(value).hostname || "this page";
    } catch (_error) {
      return "this page";
    }
  }

  function pageScopeKeyForUrl(value) {
    try {
      if (Instagram && typeof Instagram.routeKeyForUrl === "function") {
        const instagramKey = Instagram.routeKeyForUrl(value);
        if (instagramKey) {
          return instagramKey;
        }
      }
    } catch (_error) {
      // Non-Instagram pages use the ordinary site scope below.
    }
    return Core.siteKeyForUrl(value);
  }

  function isNormalSidebarTab(tab) {
    const value = String(tab && tab.url || "").trim();
    if (!value) {
      // Without host access Firefox may omit tab.url. Treat that as unknown so
      // a failed scan reveals the permission CTA instead of hiding it as if
      // this were a known protected page.
      return true;
    }
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:" || protocol === "file:";
    } catch (_error) {
      return false;
    }
  }

  function updateSidebarFollowButton() {
    const button = elements["sidebar-follow-button"];
    if (!button) {
      return;
    }
    button.hidden = !sidebarMode || state.sidebarHasBroadAccess || !state.sidebarPermissionNeeded;
    button.disabled = false;
  }

  function revealSidebarFollowPermission() {
    if (!sidebarMode || state.sidebarHasBroadAccess) {
      return;
    }
    state.sidebarPermissionNeeded = true;
    updateSidebarFollowButton();
  }

  function resetSidebarPageState(label, notice, noticeType) {
    saveCurrentGallery();
    stopGalleryCollection();
    galleryContext = null;
    resetCollectionView();
    state.images = [];
    markFilenamePreviewsDirty();
    state.selected.clear();
    state.explicitRedownloads.clear();
    downloadStatusGeneration += 1;
    state.scanWarnings = [];
    state.pageTitle = "";
    state.pageUrl = "";
    state.pageScopeKey = "";
    state.instagramCollectionFilter = "all";
    updateInstagramCollectionFilterUi();
    state.showIgnored = false;
    state.siteKey = "";
    state.ignoredKeys.clear();
    elements["image-list"].replaceChildren();
    elements["page-label"].textContent = label;
    updateFilenameTemplateUi();
    setNotice(notice, noticeType);
    renderImages();
  }

  function showSidebarLoading(tab) {
    state.sidebarPermissionNeeded = !state.sidebarHasBroadAccess;
    updateSidebarFollowButton();
    resetSidebarPageState(
      tab && tab.title ? tab.title : "Loading the active page…",
      "Waiting for the active page to finish loading…"
    );
  }

  function showProtectedSidebarPage(tab) {
    state.sidebarPermissionNeeded = false;
    updateSidebarFollowButton();
    resetSidebarPageState(
      tab && tab.title ? tab.title : "This page cannot be scanned",
      "Firefox does not allow extensions to inspect this page. Switch to a normal website and the sidebar will update automatically."
    );
  }

  function sidebarScanStillCurrent(settings) {
    return !settings.sidebarFollow || (
      sidebarMode &&
      settings.sidebarGeneration === sidebarFollowGeneration &&
      (!Number.isInteger(settings.tabId) || settings.tabId === state.sourceTabId)
    );
  }

  function scanSourceStillCurrent(settings, generation) {
    return generation === sourcePageGeneration && sidebarScanStillCurrent(settings);
  }

  async function sourceTabForScan(options) {
    const pinnedSource = Boolean(options && options.pinnedSource);
    const requestedTabId = options && options.tabId;
    if (Number.isSafeInteger(requestedTabId)) {
      return browser.tabs.get(requestedTabId);
    }
    if ((managerTabMode || pinnedSource) && Number.isInteger(state.sourceTabId)) {
      return browser.tabs.get(state.sourceTabId);
    }

    const query = { active: true };
    if (sidebarMode && Number.isInteger(state.sidebarWindowId)) {
      query.windowId = state.sidebarWindowId;
    } else {
      query.currentWindow = true;
    }
    const tabs = await browser.tabs.query(query);
    return tabs[0] || null;
  }

  function validIgnoredKey(value) {
    return /^(?:data|url):\d{1,7}:[a-f0-9]{16}$/.test(String(value || ""));
  }

  function ignoreStorageArea(incognito) {
    return incognito ? browser.storage.session : {
      get: (keys) => browser.storage.local.get(keys),
      set: (values) => writeNormalStorage("set", values),
      remove: (keys) => writeNormalStorage("remove", Array.isArray(keys) ? keys : [keys])
    };
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

    if (changed) {
      if (!state.busy) {
        renderImages();
      }
    }
  }

  function ignoredKey(image) {
    if (!image || typeof image !== "object") {
      return "";
    }
    if (ignoredKeyByImage.has(image)) {
      return ignoredKeyByImage.get(image);
    }
    const key = Core.ignoreKeyForUrl(image.url);
    ignoredKeyByImage.set(image, key);
    return key;
  }

  function isImageIgnored(image) {
    const key = ignoredKey(image);
    return Boolean(key && state.ignoredKeys.has(key));
  }

  function focusIgnoredToggle() {
    const target = elements["smart-filter-panel"].matches(":popover-open")
      ? elements["ignored-button"] : elements["smart-filters-button"];
    try {
      target.focus({ preventScroll: true });
    } catch (_error) {
      target.focus();
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
      setNotice("This media item cannot be added to the ignore list.", "error");
      return;
    }
    if (!state.ignoredKeys.has(key) && state.ignoredKeys.size >= MAX_IGNORED_PER_SITE) {
      setNotice(`This website already has the maximum of ${MAX_IGNORED_PER_SITE} ignored media rules.`, "error");
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
      setNotice(`The media item is hidden for now, but Firefox could not remember it: ${error.message || error}`, "error");
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
      setNotice(`The media item is restored for now, but Firefox could not remember it: ${error.message || error}`, "error");
    }
  }

  async function restoreAllIgnoredImages() {
    if (
      state.ignoredKeys.size > 1 &&
      !window.confirm(
        `Restore all ${state.ignoredKeys.size.toLocaleString()} ignored-media rules for this website? Restored items will remain unselected.`
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
    setNotice("Restored all ignored-media rules for this website. Restored items remain unselected.");
    renderImages();
    focusIgnoredToggle();
    try {
      await clearPersistedIgnoredRules();
    } catch (error) {
      setNotice(`The media items are restored for now, but Firefox could not clear the stored rules: ${error.message || error}`, "error");
    }
  }

  function createPreviewId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const random = crypto.getRandomValues(new Uint32Array(2));
    return `${Date.now().toString(36)}-${random[0].toString(36)}-${random[1].toString(36)}`;
  }

  function openGalleryPreview(image) {
    previewItems = filteredImages().map(mediaIdentityKey);
    previewIndex = previewItems.indexOf(mediaIdentityKey(image));
    if (previewIndex < 0) {
      previewItems = [mediaIdentityKey(image)];
      previewIndex = 0;
    }
    previewOpener = document.activeElement;
    updateGalleryPreview();
    elements["media-preview-dialog"].showModal();
  }

  function currentPreviewImage() {
    return state.images.find((image) => mediaIdentityKey(image) === previewItems[previewIndex]);
  }

  function updatePreviewSelection(image) {
    if (!image) return;
    const status = downloadStatusFor(image);
    elements["preview-selected-input"].checked = state.selected.has(image.url) && imageCanBeSelected(image);
    elements["preview-selected-input"].disabled = state.busy || isImageIgnored(image) || status === "queued";
    elements["preview-selected-text"].textContent = status === "downloaded" ? "Select to download again" : "Selected for download";
    elements["preview-download-button"].textContent = status === "downloaded" ? "Download again" : status === "queued" ? "Queued" : "Download";
    elements["preview-download-button"].disabled = state.busy || Boolean(galleryCollection) || isImageIgnored(image) || status === "queued";
  }

  function updateGalleryPreview() {
    const image = currentPreviewImage();
    const stage = elements["media-preview-stage"];
    clearPreviewStage();
    elements["media-preview-error"].hidden = true;
    if (!image) {
      if (elements["media-preview-dialog"].open) elements["media-preview-dialog"].close();
      return;
    }
    const youtube = Boolean(Gallery.youtubeUrl(image));
    const video = mediaTypeFor(image) === "video" && !youtube;
    const result = Core.validateMediaUrl(youtube ? image.previewUrl : image.url);
    if (result.ok) {
      const media = document.createElement(video ? "video" : "img");
      media.referrerPolicy = "no-referrer";
      if (video) {
        media.controls = true;
        media.preload = "metadata";
        media.playsInline = true;
      } else {
        media.alt = String(image.alt || "").slice(0, 500);
      }
      media.addEventListener("error", () => { if (media.isConnected) elements["media-preview-error"].hidden = false; });
      media.src = result.value;
      stage.appendChild(media);
    } else {
      elements["media-preview-error"].hidden = false;
    }
    elements["media-preview-title"].textContent = friendlyFilename(image);
    elements["media-preview-meta"].textContent = `${imageMetaText(image)}${youtube ? " · Open in new tab to play on YouTube" : ""}`;
    elements["media-preview-position"].textContent = `${previewIndex + 1} of ${previewItems.length}`;
    elements["preview-previous-button"].disabled = previewIndex <= 0;
    elements["preview-next-button"].disabled = previewIndex >= previewItems.length - 1;
    const sourceUrl = Gallery.pageUrl(image.pageUrl || state.pageUrl);
    elements["preview-source-link"].hidden = !sourceUrl;
    if (sourceUrl) elements["preview-source-link"].href = sourceUrl;
    updatePreviewSelection(image);
  }

  function moveGalleryPreview(offset) {
    const next = previewIndex + offset;
    if (next >= 0 && next < previewItems.length) {
      previewIndex = next;
      updateGalleryPreview();
    }
  }

  function clearPreviewStage() {
    const stage = elements["media-preview-stage"];
    for (const video of stage.querySelectorAll("video")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    stage.replaceChildren();
  }

  function selectImage(image, selected) {
    if (!image || (state.busy && !state.liveScanning) || downloadStatusFor(image) === "queued" || isImageIgnored(image)) return false;
    if (selected) {
      if (downloadStatusFor(image) === "downloaded" && image.downloadFingerprint) state.explicitRedownloads.add(image.downloadFingerprint);
      state.selected.add(image.url);
    } else {
      state.selected.delete(image.url);
      if (image.downloadFingerprint) state.explicitRedownloads.delete(image.downloadFingerprint);
    }
    refreshRenderedFilenamePreviews();
    updateSummary();
    return true;
  }

  async function openImagePreview(image) {
    if (Gallery.youtubeUrl(image)) {
      const createProperties = { active: true, url: `https://www.youtube.com/watch?v=${image.videoId}` };
      if (Number.isInteger(state.sourceWindowId)) {
        createProperties.windowId = state.sourceWindowId;
      }
      await browser.tabs.create(createProperties).catch((error) => setNotice(error.message, "error"));
      return;
    }
    const validateMediaUrl = Core.validateMediaUrl || Core.validateDownloadUrl;
    const urlResult = validateMediaUrl(image && image.url);
    if (!urlResult.ok) {
      setNotice(`Cannot preview this media file: ${urlResult.error}`, "error");
      return;
    }

    const previewResult = image && image.previewUrl
      ? validateMediaUrl(image.previewUrl)
      : { ok: false };

    const id = createPreviewId();
    const key = `imagePreview:${id}`;
    const payload = {
      url: urlResult.value,
      previewUrl: previewResult.ok ? previewResult.value : "",
      name: friendlyFilename(image),
      alt: String(image.alt || "").slice(0, 500),
      duration: Math.max(0, Number(image.duration) || 0),
      mediaType: mediaTypeFor(image),
      sourceUrl: Gallery.pageUrl(image.pageUrl || state.pageUrl),
      sourceTabId: state.sourceTabId,
      createdAt: Date.now()
    };
    try {
      await browser.storage.session.set({ [key]: payload });
    } catch (error) {
      setNotice(`Firefox could not prepare the in-memory media preview: ${error.message || error}`, "error");
      return;
    }

    const previewUrl = browser.runtime.getURL(`preview/preview.html?id=${encodeURIComponent(id)}`);
    const createProperties = { url: previewUrl, active: true };
    if (Number.isInteger(state.sourceWindowId)) {
      createProperties.windowId = state.sourceWindowId;
    }
    try {
      await browser.tabs.create(createProperties);
    } catch (error) {
      await browser.storage.session.remove(key).catch(() => undefined);
      setNotice(`Firefox could not open the preview tab: ${error.message || error}`, "error");
    }
  }

  function mergeScanResults(injectionResults) {
    const validateMediaUrl = Core.validateMediaUrl || Core.validateDownloadUrl;
    const byIdentity = new Map();
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
        const urlResult = validateMediaUrl(image && image.url);
        if (!urlResult.ok) {
          continue;
        }
        const normalizedUrl = urlResult.value;
        const previewResult = image && image.previewUrl
          ? validateMediaUrl(image.previewUrl)
          : { ok: false };
        const normalizedPreviewUrl = previewResult.ok && previewResult.value !== normalizedUrl
          ? previewResult.value
          : "";
        const identityKey = normalizedMediaIdentity(image && image.identityKey);
        const recordKey = mediaIdentityKey({ url: normalizedUrl, identityKey });
        const incoming = {
          url: normalizedUrl,
          pageUrl: String(image.pageUrl || primaryPage.pageUrl || "").slice(0, 16384),
          pageTitle: String(image.pageTitle || primaryPage.pageTitle || "").slice(0, 300),
          identityKey,
          originalMediaType: image.originalMediaType === 1 && image.mediaType === "image" &&
            image.sourceProvider === "instagram" ? 1 : undefined,
          previewUrl: normalizedPreviewUrl,
          filename: String(image.filename || "").slice(0, 500),
          alt: String(image.alt || "").slice(0, 500),
          width: Math.max(0, Number(image.width) || 0),
          height: Math.max(0, Number(image.height) || 0),
          duration: Math.max(0, Number(image.duration) || 0),
          mediaType: image && image.mediaType === "video" ? "video" : "image",
          mimeType: String(image && image.mimeType || "").slice(0, 100),
          sourceProvider: String(image && image.sourceProvider || "").slice(0, 50),
          videoId: /^[A-Za-z0-9_-]{11}$/.test(String(image && image.videoId || ""))
            ? String(image.videoId)
            : "",
          qualityLabel: String(image && image.qualityLabel || "").slice(0, 40),
          hasAudio: typeof (image && image.hasAudio) === "boolean" ? image.hasAudio : null,
          itag: Math.max(0, Math.round(Number(image && image.itag) || 0)),
          instagramCollections: normalizedInstagramCollections(
            image && image.instagramCollections
          ),
          kinds: Array.from(image.kinds || [])
            .slice(0, 8)
            .map((kind) => String(kind).slice(0, 50))
        };
        const current = byIdentity.get(recordKey);
        if (!current) {
          if (
            byIdentity.size >= MAX_DISCOVERED_IMAGES ||
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
          incoming.previewUrl = previewUrl;
          byIdentity.set(recordKey, incoming);
          continue;
        }
        if (current.originalMediaType === 1 || incoming.originalMediaType === 1) {
          const combined = mergeMediaRecord(current, incoming);
          const nextLength = totalUrlLength - current.url.length - String(current.previewUrl || "").length +
            combined.url.length + String(combined.previewUrl || "").length;
          if (nextLength <= Core.MAX_BATCH_TOTAL_URL_LENGTH) {
            byIdentity.set(recordKey, combined);
            totalUrlLength = nextLength;
          } else {
            aggregateLimitReached = true;
          }
          continue;
        }
        for (const kind of image.kinds || []) {
          const safeKind = String(kind).slice(0, 50);
          if (current.kinds.length < 8 && !current.kinds.includes(safeKind)) {
            current.kinds.push(safeKind);
          }
        }
        const currentArea = (Number(current.width) || 0) * (Number(current.height) || 0);
        const nextArea = (Number(image.width) || 0) * (Number(image.height) || 0);
        if (nextArea >= currentArea) {
          const nextPreviewUrl = normalizedPreviewUrl || current.previewUrl || "";
          const oldUrlLength = current.url.length + String(current.previewUrl || "").length;
          const nextUrlLength = normalizedUrl.length + nextPreviewUrl.length;
          if (totalUrlLength - oldUrlLength + nextUrlLength <= Core.MAX_BATCH_TOTAL_URL_LENGTH) {
            totalUrlLength += nextUrlLength - oldUrlLength;
            current.url = normalizedUrl;
            current.previewUrl = nextPreviewUrl;
          }
        }
        current.instagramCollections = mergeInstagramCollections(
          current.instagramCollections,
          image.instagramCollections
        );
        current.width = Math.max(current.width || 0, image.width || 0);
        current.height = Math.max(current.height || 0, image.height || 0);
        current.duration = Math.max(current.duration || 0, Number(image.duration) || 0);
        current.mediaType = current.mediaType === "video" || image.mediaType === "video"
          ? "video"
          : "image";
        current.mimeType = current.mimeType || String(image.mimeType || "").slice(0, 100);
        current.filename = current.filename || String(image.filename || "").slice(0, 500);
        current.sourceProvider = current.sourceProvider ||
          String(image.sourceProvider || "").slice(0, 50);
        current.videoId = current.videoId ||
          (/^[A-Za-z0-9_-]{11}$/.test(String(image.videoId || "")) ? String(image.videoId) : "");
        current.qualityLabel = current.qualityLabel || String(image.qualityLabel || "").slice(0, 40);
        if (current.hasAudio === null && typeof image.hasAudio === "boolean") {
          current.hasAudio = image.hasAudio;
        }
        current.itag = current.itag || Math.max(0, Math.round(Number(image.itag) || 0));
        current.alt = current.alt || String(image.alt || "").slice(0, 500);
        current.identityKey = current.identityKey || identityKey;
        if (!current.previewUrl && normalizedPreviewUrl &&
          totalUrlLength + normalizedPreviewUrl.length <= Core.MAX_BATCH_TOTAL_URL_LENGTH) {
          current.previewUrl = normalizedPreviewUrl;
          totalUrlLength += normalizedPreviewUrl.length;
        }
      }
    }

    if (aggregateLimitReached) {
      warnings.add(`Combined frame results were trimmed to the ${MAX_DISCOVERED_IMAGES.toLocaleString()}-item and 2 MB safety limits.`);
    }
    if (primaryPage && primaryPage.embeddedFrameCount > scannedChildFrames) {
      warnings.add("Some embedded frames could not be inspected with temporary page access.");
    }

    return {
      page: primaryPage,
      images: Array.from(byIdentity.values()),
      warnings: Array.from(warnings)
    };
  }

  function folderStatus() {
    const result = Core.validateFolderPath(elements["folder-input"].value);
    if (!result.ok) {
      elements["folder-help"].textContent = result.error;
      elements["folder-help"].classList.add("error");
      elements["folder-help"].hidden = false;
      elements["folder-input"].setAttribute("aria-invalid", "true");
      return result;
    }

    elements["folder-help"].textContent = "";
    elements["folder-help"].classList.remove("error");
    elements["folder-help"].hidden = true;
    elements["folder-input"].removeAttribute("aria-invalid");
    return result;
  }

  function smartFiltersFromControls() {
    return Filters.normalizeFilters({
      photosOnly: elements["photos-only-input"].checked,
      mediaType: elements["media-type-filter-select"].value,
      format: elements["format-filter-select"].value,
      minWidth: elements["min-width-input"].value,
      minHeight: elements["min-height-input"].value,
      orientation: elements["orientation-filter-select"].value
    });
  }

  function applySmartFiltersToControls(filters) {
    const normalized = Filters.normalizeFilters(filters);
    state.smartFilters = normalized;
    elements["photos-only-input"].checked = normalized.photosOnly;
    elements["media-type-filter-select"].value = normalized.mediaType;
    elements["format-filter-select"].value = normalized.format;
    elements["min-width-input"].value = String(normalized.minWidth || 0);
    elements["min-height-input"].value = String(normalized.minHeight || 0);
    elements["orientation-filter-select"].value = normalized.orientation || "any";
  }

  function smartFilterCount(filters) {
    const normalized = Filters.normalizeFilters(filters);
    return Number(normalized.photosOnly) +
      Number(normalized.mediaType !== "any") +
      Number(normalized.format !== "any") + Number(normalized.minWidth > 0) +
      Number(normalized.minHeight > 0) + Number(normalized.orientation && normalized.orientation !== "any");
  }

  function updateSmartFilterButton() {
    const count = smartFilterCount(state.smartFilters) +
      Number(state.instagramCollectionFilter !== "all");
    const button = elements["smart-filters-button"];
    button.textContent = count ? `Filters (${count})` : "Filters";
    button.classList.toggle("active", count > 0 || elements["smart-filter-panel"].matches(":popover-open"));
  }

  function imageMatchesSmartFilters(image) {
    return state.showIgnored || Filters.matchesSmartFilters(image, state.smartFilters);
  }

  function imageMatchesInstagramCollectionFilter(image) {
    return state.showIgnored || matchesInstagramCollectionFilter(
      image,
      state.instagramCollectionFilter
    );
  }

  function updateInstagramCollectionFilterUi() {
    const field = elements["instagram-collection-filter-field"];
    const select = elements["instagram-collection-filter-select"];
    if (!field || !select) {
      return;
    }
    let profileRoute = false;
    try {
      profileRoute = Boolean(
        Instagram &&
        typeof Instagram.routeKeyForUrl === "function" &&
        Instagram.routeKeyForUrl(state.pageUrl).startsWith("instagram:profile:")
      );
    } catch (_error) {
      profileRoute = false;
    }
    field.hidden = !profileRoute;
    if (!profileRoute) {
      state.instagramCollectionFilter = "all";
      select.value = "all";
      updateSmartFilterButton();
      return;
    }

    const highlights = new Map();
    for (const image of state.images) {
      for (const collection of normalizedInstagramCollections(image.instagramCollections)) {
        if (collection.type === "highlight" && !highlights.has(collection.id)) {
          highlights.set(collection.id, collection.title || `Highlight ${highlights.size + 1}`);
        }
      }
    }
    const optionDefinitions = [
      ["all", "All profile media"],
      ["posts", "Posts only"],
      ["story", "Current story only"],
      ["highlights", "All highlights"],
      ...Array.from(highlights, ([id, title]) => [`highlight:${id}`, title])
    ];
    const previous = state.instagramCollectionFilter;
    select.replaceChildren(...optionDefinitions.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
    state.instagramCollectionFilter = optionDefinitions.some(([value]) => value === previous)
      ? previous
      : "all";
    select.value = state.instagramCollectionFilter;
    updateSmartFilterButton();
  }

  function persistSmartFilters() {
    persistSettings({ smartFilters: state.smartFilters }).catch((error) => setNotice(error.message, "error"));
  }

  function handleSmartFilterChange() {
    state.showSelected = false;
    state.smartFilters = smartFiltersFromControls();
    updateSmartFilterButton();
    persistSmartFilters();
    resetGalleryPage();
  }

  function scheduleSmartFilterRefresh() {
    if (!Filters.hasActiveSmartFilters(state.smartFilters) || smartFilterRefreshTimer !== null) {
      return;
    }
    smartFilterRefreshTimer = setTimeout(() => {
      smartFilterRefreshTimer = null;
      renderImages();
    }, 50);
  }

  function downloadStatusFor(image) {
    return ["queued", "downloaded", "failed"].includes(image && image.downloadStatus)
      ? image.downloadStatus
      : "new";
  }

  function imageCanBeSelected(image) {
    const status = downloadStatusFor(image);
    if (status === "queued") {
      return false;
    }
    if (status === "downloaded") {
      return Boolean(image.downloadFingerprint) && state.explicitRedownloads.has(image.downloadFingerprint);
    }
    return true;
  }

  async function refreshDownloadStatuses(options) {
    const settings = Object.assign({ render: true }, options || {});
    if (!state.pageUrl || !state.images.length) {
      return false;
    }
    const generation = ++downloadStatusGeneration;
    const requestedPageUrl = state.pageUrl;
    const requested = state.images.map((image) => ({
      key: mediaIdentityKey(image),
      url: image.url,
      identityKey: normalizedMediaIdentity(image.identityKey)
    }));
    const response = await browser.runtime.sendMessage({
      type: "GET_MEDIA_DOWNLOAD_STATUS",
      incognito: state.incognito,
      pageUrl: requestedPageUrl,
      items: requested.map(({ url, identityKey }) => ({ url, identityKey }))
    });
    if (
      generation !== downloadStatusGeneration ||
      requestedPageUrl !== state.pageUrl ||
      !response ||
      !response.ok ||
      !Array.isArray(response.statuses)
    ) {
      if (response && response.ok === false) {
        throw new Error(response.error || "Firefox could not read completed-download status.");
      }
      return false;
    }
    const byIdentity = new Map();
    response.statuses.forEach((status, index) => {
      const request = requested[index];
      if (request) {
        byIdentity.set(request.key, status || {});
      }
    });
    for (const image of state.images) {
      const status = byIdentity.get(mediaIdentityKey(image)) || {};
      image.downloadStatus = ["queued", "downloaded", "failed"].includes(status.status)
        ? status.status
        : "new";
      image.downloadFingerprint = String(status.fingerprint || "");
      image.downloadedAt = Number(status.completedAt) || 0;
      image.downloadedFilename = String(status.filename || "");
      if (!imageCanBeSelected(image)) {
        state.selected.delete(image.url);
      }
    }
    if (settings.render) {
      renderImages();
    }
    return true;
  }

  function scheduleDownloadStatusRefresh() {
    if (downloadStatusRefreshTimer !== null) {
      clearTimeout(downloadStatusRefreshTimer);
    }
    downloadStatusRefreshTimer = setTimeout(() => {
      downloadStatusRefreshTimer = null;
      if (state.busy) {
        scheduleDownloadStatusRefresh();
        return;
      }
      refreshDownloadStatuses().catch((error) => {
        console.error("AnyDownload could not refresh completed-download status.", error);
      });
    }, 120);
  }

  function handleDownloadStatusStorageChanges(changes, areaName) {
    const expectedArea = state.incognito ? "session" : "local";
    if (
      areaName !== expectedArea ||
      !changes ||
      (!changes["downloadLedger:v1"] && !changes["downloadQueueState:v1"]) ||
      !state.pageUrl
    ) {
      return;
    }
    scheduleDownloadStatusRefresh();
  }

  function filteredImages() {
    if (state.showSelected) return sortImages(selectedDownloadableImages());
    const query = elements["filter-input"].value.trim().toLocaleLowerCase();
    const inCurrentView = state.images.filter((image) =>
      isImageIgnored(image) === state.showIgnored &&
      (!state.hideDownloaded || state.showIgnored || downloadStatusFor(image) !== "downloaded") &&
      imageMatchesSmartFilters(image) &&
      imageMatchesInstagramCollectionFilter(image)
    );
    if (!query) {
      return sortImages(inCurrentView);
    }
    return sortImages(inCurrentView.filter((image) => {
      const haystack = `${image.url} ${image.filename || ""} ${image.alt || ""} ${image.pageTitle || ""} ${(image.kinds || []).join(" ")}`.toLocaleLowerCase();
      return haystack.includes(query);
    }));
  }

  function sortImages(images) {
    if (state.sort === "name") images.sort((a, b) => baseFilenameForMedia(a, 0).localeCompare(baseFilenameForMedia(b, 0), undefined, { numeric: true }));
    if (state.sort === "resolution") images.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    return images;
  }

  function hasCollectionFilter() {
    return Boolean(elements["filter-input"].value.trim()) || state.showSelected ||
      (!state.showIgnored && (state.hideDownloaded || Filters.hasActiveSmartFilters(state.smartFilters) || state.instagramCollectionFilter !== "all"));
  }

  function resetGalleryPage() {
    state.galleryPage = 0;
    elements["image-list"].scrollTop = 0;
    renderImages();
  }

  function resetCollectionView() {
    state.showSelected = false;
    state.galleryPage = 0;
    clearedGallery = null;
    elements["gallery-undo"].hidden = true;
    if (elements["media-preview-dialog"].open) elements["media-preview-dialog"].close();
  }

  function reconcileGallerySelection(previousImages, preserve) {
    const known = new Set(previousImages.map(mediaIdentityKey));
    return new TrackedSelectionSet(reconcileScanSelection(state.images, previousImages, state.selected, preserve,
      (image) => !isImageIgnored(image) && imageCanBeSelected(image) && (preserve && known.has(mediaIdentityKey(image)) ||
        Filters.matchesSmartFilters(image, state.smartFilters) && matchesInstagramCollectionFilter(image, state.instagramCollectionFilter))));
  }

  function selectedDownloadableImages() {
    return state.images.filter((image) =>
      state.selected.has(image.url) &&
      imageCanBeSelected(image) &&
      !isImageIgnored(image)
    );
  }

  function firstSelectedDownloadableImage() {
    return state.images.find((image) =>
      state.selected.has(image.url) &&
      imageCanBeSelected(image) &&
      !isImageIgnored(image)
    );
  }

  function friendlyFilename(image) {
    if (state.filenamePreviewByUrl.has(image.url)) {
      return state.filenamePreviewByUrl.get(image.url);
    }
    const index = Math.max(0, state.images.indexOf(image));
    return baseFilenameForMedia(image, index);
  }

  function validPixelDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 1000000
      ? Math.round(number)
      : 0;
  }

  function currentImageForUrl(url) {
    if (indexedImages !== state.images) {
      indexedImages = state.images;
      imageByUrl = new Map(state.images.map((image) => [image.url, image]));
    }
    return imageByUrl.get(url) || null;
  }

  function applyMeasuredDimensions(image, width, height) {
    width = validPixelDimension(width);
    height = validPixelDimension(height);
    if (!width || !height) {
      image.dimensionStatus = "unavailable";
      return false;
    }
    if (image.width !== width || image.height !== height) {
      markFilenamePreviewsDirty();
    }
    image.width = width;
    image.height = height;
    image.dimensionStatus = "known";
    return true;
  }

  function formatMediaDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "";
    }
    const rounded = Math.round(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const remainder = rounded % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function imageMetaText(image) {
    const video = mediaTypeFor(image) === "video";
    let dimensions = video ? "resolution unknown" : "size unknown";
    if (image.width && image.height) {
      dimensions = `${Math.round(image.width).toLocaleString()} × ${Math.round(image.height).toLocaleString()}`;
    } else if (!video && image.dimensionStatus === "loading") {
      dimensions = "checking full size…";
    } else if (!video && image.dimensionStatus === "unavailable") {
      dimensions = "full size unavailable";
    }
    const duration = video ? formatMediaDuration(image.duration) : "";
    return [dimensions, duration, (image.kinds || [video ? "Video" : "Image"]).join(", ")]
      .filter(Boolean)
      .join(" · ");
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
    const matchedBefore = Filters.matchesSmartFilters(image, state.smartFilters);
    const applied = applyMeasuredDimensions(image, result.width, result.height);
    updateImageMetas(url);
    if (applied) {
      refreshRenderedFilenamePreviews();
    }
    if (matchedBefore !== Filters.matchesSmartFilters(image, state.smartFilters)) {
      scheduleSmartFilterRefresh();
    }
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
    if (mediaTypeFor(image) === "video") {
      return Promise.resolve(false);
    }
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
    const thumbnailIsFullImage = mediaTypeFor(image) === "image" && source === image.url;
    if (!image.width || !image.height) {
      if (thumbnailIsFullImage) {
        image.dimensionStatus = "loading";
        updateImageMetas(image.url);
        thumbnail.addEventListener("load", () => {
          const current = currentImageForUrl(image.url);
          if (current && (!current.width || !current.height)) {
            const matchedBefore = Filters.matchesSmartFilters(current, state.smartFilters);
            const applied = applyMeasuredDimensions(current, thumbnail.naturalWidth, thumbnail.naturalHeight);
            if (applied) {
              refreshRenderedFilenamePreviews();
            }
            if (matchedBefore !== Filters.matchesSmartFilters(current, state.smartFilters)) {
              scheduleSmartFilterRefresh();
            }
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

  function updateSummary(visibleImages) {
    updateGalleryControls();
    elements["page-label"].title = elements["page-label"].textContent;
    scheduleGallerySave();
    const total = state.images.length;
    const selectionBusy = state.busy && !state.liveScanning;
    const ignoredCount = state.images.filter(isImageIgnored).length;
    const storedIgnoredCount = state.ignoredKeys.size;
    const availableCount = total - ignoredCount;
    const downloadedCount = state.images.filter((image) =>
      !isImageIgnored(image) && downloadStatusFor(image) === "downloaded"
    ).length;
    const queuedCount = state.images.filter((image) =>
      !isImageIgnored(image) && downloadStatusFor(image) === "queued"
    ).length;
    const selectedItems = selectedDownloadableImages();
    const selected = selectedItems.length;
    const selectedHasVideo = selectedItems.some((item) => mediaTypeFor(item) === "video");
    const visible = Array.isArray(visibleImages) ? visibleImages : filteredImages();
    const visibleUrls = new Set(visible.map((image) => image.url));
    const hiddenSelected = selectedItems.filter((image) => !visibleUrls.has(image.url)).length;
    const hasFilter = hasCollectionFilter();
    const folder = folderStatus();
    const template = filenameTemplateStatus();
    const viewTotal = state.showIgnored ? ignoredCount : availableCount;
    elements["summary-label"].textContent = state.showSelected ? `${visible.length.toLocaleString()} selected files` : hasFilter
      ? `${visible.length.toLocaleString()} of ${viewTotal.toLocaleString()} ${state.showIgnored ? "ignored" : "available"} shown`
      : state.showIgnored
        ? storedIgnoredCount === ignoredCount
          ? `${ignoredCount.toLocaleString()} ignored item${ignoredCount === 1 ? "" : "s"}`
          : `${ignoredCount.toLocaleString()} on this page · ${storedIgnoredCount.toLocaleString()} site rules`
        : `${availableCount.toLocaleString()} media item${availableCount === 1 ? "" : "s"}`;
    elements["ignored-button"].textContent = state.showIgnored ? "Show media" : `Ignored (${storedIgnoredCount.toLocaleString()})`;
    elements["ignored-button"].disabled = state.busy || (!storedIgnoredCount && !state.showIgnored);
    elements["ignored-button"].classList.toggle("active", state.showIgnored);
    elements["ignored-button"].setAttribute("aria-pressed", String(state.showIgnored));
    elements["clear-ignored-button"].hidden = !state.showIgnored || !storedIgnoredCount;
    elements["clear-ignored-button"].disabled = state.busy;
    elements["downloaded-button"].hidden = state.showIgnored;
    elements["downloaded-button"].disabled = state.busy || downloadedCount === 0;
    elements["downloaded-button"].textContent = state.hideDownloaded
      ? `Show downloaded (${downloadedCount.toLocaleString()})`
      : `Hide downloaded (${downloadedCount.toLocaleString()})`;
    elements["downloaded-button"].classList.toggle("active", state.hideDownloaded);
    elements["downloaded-button"].setAttribute("aria-pressed", String(state.hideDownloaded));
    elements["select-all-button"].hidden = state.showIgnored || state.showSelected;
    elements["select-none-button"].hidden = state.showIgnored;
    elements["select-all-button"].disabled = selectionBusy || !visible.some((image) =>
      downloadStatusFor(image) !== "downloaded" && imageCanBeSelected(image)
    );
    elements["select-none-button"].disabled = selectionBusy || !visible.some((image) => state.selected.has(image.url));
    elements["select-all-button"].textContent = hasFilter ? "Select matches only" : "Select all";
    elements["select-none-button"].textContent = hasFilter ? "Deselect matches" : "Deselect";
    elements["download-button"].hidden = state.showIgnored;
    elements["archive-footer-button"].hidden = state.showIgnored;
    elements["upload-button"].hidden = state.showIgnored || state.incognito;
    elements["selected-label"].textContent = state.showIgnored
      ? `${ignoredCount.toLocaleString()} ignored here`
      : `${selected.toLocaleString()} selected${hiddenSelected ? ` · ${hiddenSelected.toLocaleString()} hidden` : ""}`;
    elements["selected-label"].setAttribute("aria-pressed", String(state.showSelected));
    elements["selected-label"].setAttribute("aria-label", state.showSelected ? "Back to collection" : `Review ${selected} selected files`);
    elements["selected-label"].disabled = state.showIgnored || (!selected && !state.showSelected);
    elements["back-to-collection-button"].hidden = !state.showSelected;
    elements["action-detail"].textContent = editTrackerId ? `Downloads/${folder.value || ""}` : state.showIgnored
      ? storedIgnoredCount === ignoredCount
        ? "Restore media to make it downloadable again"
        : `${storedIgnoredCount.toLocaleString()} rules saved for this site`
      : selected
        ? !folder.ok
          ? folder.error
          : !template.ok
            ? template.error
            : `Downloads/${folder.value}`
        : queuedCount
          ? `${queuedCount.toLocaleString()} item${queuedCount === 1 ? " is" : "s are"} already queued`
          : downloadedCount
            ? `${downloadedCount.toLocaleString()} previously downloaded · check one to download again`
            : "Choose files to download";
    const warning = [hiddenSelected ? `Download includes ${hiddenSelected} files hidden by your filters. Review selected before downloading.` : "",
      selectedHasVideo ? "ZIP supports images only. Choose Images, then Select matches only." : ""].filter(Boolean).join(" ");
    elements["selection-warning"].textContent = warning;
    elements["selection-warning"].hidden = state.showIgnored || !warning;
    elements["download-button"].textContent = selected === 1
      ? `Download ${mediaTypeFor(selectedItems[0])}`
      : selected ? `Download ${selected.toLocaleString()} files` : "Download selected";
    elements["action-detail"].title = elements["action-detail"].textContent;
    elements["download-settings-button"].classList.toggle("active", !folder.ok || !template.ok);
    elements["download-settings-button"].title = folder.ok
      ? `Download settings · Downloads/${folder.value}`
      : `Fix destination folder: ${folder.error}`;
    elements["download-button"].disabled = state.busy || Boolean(galleryCollection) || selected === 0 || !folder.ok || !template.ok;
    elements["archive-footer-button"].disabled = state.busy || Boolean(galleryCollection) || selected === 0 ||
      selectedHasVideo || !folder.ok || !template.ok;
    elements["archive-footer-button"].title = selectedHasVideo
      ? "ZIP archives currently support image-only selections"
      : "Download selected images as ZIP archives";
    elements["upload-button"].disabled = state.incognito || state.busy || Boolean(galleryCollection) ||
      selected === 0 || selected > 500 || selectedHasVideo || !template.ok;
    elements["upload-button"].title = "Upload up to 500 selected images, including previously downloaded images";
    updateInstagramCollectionsButton();
    elements["image-list"].setAttribute(
      "aria-label",
      state.showSelected ? "Selected media" : state.showIgnored ? "Ignored media" : "Saved media from this website"
    );
    if (elements["media-preview-dialog"].open) {
      const image = currentPreviewImage();
      if (image) updatePreviewSelection(image);
      else elements["media-preview-dialog"].close();
    }
  }

  function makeImageRow(image) {
    const ignored = isImageIgnored(image);
    const video = mediaTypeFor(image) === "video";
    const downloadStatus = downloadStatusFor(image);
    const row = document.createElement("article");
    row.className = `image-row${video ? " video" : ""}${ignored ? " ignored" : ""}${downloadStatus === "downloaded" ? " downloaded" : ""}`;
    row.setAttribute("role", "listitem");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(image.url) && imageCanBeSelected(image);
    checkbox.disabled = (state.busy && !state.liveScanning) || downloadStatus === "queued";
    checkbox.setAttribute(
      "aria-label",
      downloadStatus === "downloaded"
        ? `Select ${friendlyFilename(image)} to download it again`
        : `Select ${friendlyFilename(image)}`
    );
    checkbox.addEventListener("change", () => {
      if (!selectImage(image, checkbox.checked)) {
        checkbox.checked = state.selected.has(image.url) && imageCanBeSelected(image);
      } else if (state.showSelected) {
        renderImages();
      }
    });

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "row-action-button preview";
    previewButton.textContent = "Preview";
    previewButton.title = `Preview ${video ? "video" : "image"}`;
    previewButton.setAttribute("aria-label", `Preview ${friendlyFilename(image)}`);
    previewButton.disabled = state.busy;
    previewButton.addEventListener("click", () => openGalleryPreview(image));

    const thumbnailFrame = document.createElement("div");
    thumbnailFrame.className = `thumbnail-frame${video ? " video" : ""}`;
    let thumbnail = null;
    const thumbnailUrl = video ? image.previewUrl : image.previewUrl || image.url;
    if (thumbnailUrl) {
      thumbnail = document.createElement("img");
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      thumbnail.dataset.src = thumbnailUrl;
      thumbnail.addEventListener("error", () => thumbnail.classList.add("broken"));
      thumbnailFrame.appendChild(thumbnail);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "video-placeholder";
      placeholder.textContent = "Video";
      thumbnailFrame.appendChild(placeholder);
    }

    const copy = document.createElement("div");
    copy.className = "image-copy";
    const name = document.createElement("div");
    name.className = "image-name";
    const filenameLabel = document.createElement("span");
    const initialFilename = friendlyFilename(image);
    filenameLabel.textContent = initialFilename;
    name.title = image.alt || initialFilename;
    name.append(filenameLabel);
    if (video) {
      const mediaBadge = document.createElement("span");
      mediaBadge.className = "media-type-badge";
      mediaBadge.textContent = "Video";
      mediaBadge.title = "Direct video file";
      name.append(mediaBadge);
    }
    const statusBadge = document.createElement("span");
    statusBadge.className = `download-status-badge ${downloadStatus}`;
    statusBadge.textContent = downloadStatus === "downloaded"
      ? "Downloaded"
      : downloadStatus === "queued"
        ? "Queued"
        : downloadStatus === "failed"
          ? "Failed"
          : "New";
    statusBadge.title = downloadStatus === "downloaded" && image.downloadedAt
      ? `Completed ${new Date(image.downloadedAt).toLocaleString()}`
      : downloadStatus === "queued"
        ? "This media is already in the download queue"
        : downloadStatus === "failed"
          ? "The latest queued attempt failed"
          : "This media has not completed through AnyDownload on this website";
    name.append(statusBadge);
    let nameRecords = renderedNameNodes.get(image.url);
    if (!nameRecords) {
      nameRecords = new Set();
      renderedNameNodes.set(image.url, nameRecords);
    }
    nameRecords.add({
      label: filenameLabel,
      container: name,
      checkbox,
      previewButton
    });
    const url = document.createElement("div");
    url.className = "image-url";
    url.textContent = image.url;
    url.title = image.url;
    const meta = document.createElement("div");
    meta.className = "image-meta";
    meta.textContent = imageMetaText(image);
    registerImageMeta(meta, image);
    copy.append(name, url, meta);

    if (thumbnail) {
      thumbnail.anydownloadImage = image;
      thumbnail.anydownloadGeneration = renderGeneration;
    }
    row.anydownloadImage = image;
    row.anydownloadThumbnail = thumbnail;
    row.anydownloadGeneration = renderGeneration;
    if (thumbnail && thumbnailObserver) {
      thumbnailObserver.observe(thumbnail);
    } else if (thumbnail) {
      loadVisibleThumbnail(thumbnail);
    }
    if (!video && dimensionObserver) {
      dimensionObserver.observe(row);
    }

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.appendChild(previewButton);
    if (ignored) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "row-action-button restore";
      restore.textContent = "Restore";
      restore.title = "Stop ignoring this media item";
      restore.disabled = state.busy;
      restore.addEventListener("click", () => restoreImage(image));
      actions.appendChild(restore);
      row.append(thumbnailFrame, copy, actions);
    } else {
      const ignore = document.createElement("button");
      ignore.type = "button";
      ignore.className = "row-action-button ignore";
      ignore.textContent = "Ignore";
      ignore.title = "Hide this media item on this website";
      ignore.disabled = state.busy;
      ignore.addEventListener("click", () => ignoreImage(image));

      const download = document.createElement("button");
      download.type = "button";
      download.className = "row-action-button download";
      download.textContent = downloadStatus === "downloaded"
        ? "Again"
        : downloadStatus === "queued"
          ? "Queued"
          : downloadStatus === "failed"
            ? "Retry"
            : "Save";
      download.title = downloadStatus === "downloaded"
        ? `Download this ${video ? "video" : "image"} again`
        : `Download only this ${video ? "video" : "image"}`;
      download.disabled = state.busy || Boolean(galleryCollection) || downloadStatus === "queued";
      download.addEventListener("click", () => requestDownloads([image], {
        allowRedownload: downloadStatus === "downloaded"
      }));
      actions.append(ignore, download);
      row.append(checkbox, thumbnailFrame, copy, actions);
      row.addEventListener("click", (event) => {
        if (!checkbox.disabled && !event.target.closest("button, input")) {
          checkbox.click();
        }
      });
    }
    checkbox.dataset.focusKey = `${mediaIdentityKey(image)}:select`;
    for (const action of actions.children) action.dataset.focusKey = `${mediaIdentityKey(image)}:${action.className}`;
    return row;
  }

  function scheduleFilterRender() {
    if (filterRenderTimer !== null) {
      clearTimeout(filterRenderTimer);
    }
    filterRenderTimer = setTimeout(() => {
      filterRenderTimer = null;
      state.showSelected = false;
      resetGalleryPage();
    }, FILTER_RENDER_DEBOUNCE_MS);
  }

  function applyMediaView(value) {
    const view = value === "list" ? "list" : "grid";
    elements["image-list"].dataset.view = view;
    elements["grid-view-button"].setAttribute("aria-pressed", String(view === "grid"));
    elements["list-view-button"].setAttribute("aria-pressed", String(view === "list"));
  }

  function resetMediaFilters() {
    elements["filter-input"].value = "";
    state.hideDownloaded = false;
    state.instagramCollectionFilter = "all";
    state.showSelected = false;
    elements["instagram-collection-filter-select"].value = "all";
    applySmartFiltersToControls(Filters.DEFAULT_FILTERS);
    handleSmartFilterChange();
    closeMediaFilters();
    elements["filter-input"].focus();
  }

  function closeMediaFilters() {
    const panel = elements["smart-filter-panel"];
    if (panel.matches(":popover-open")) {
      panel.hidePopover();
    }
  }

  function renderImages() {
    const focusedKey = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.focusKey;
    if (filterRenderTimer !== null) {
      clearTimeout(filterRenderTimer);
      filterRenderTimer = null;
    }
    updateFilenameTemplateUi();
    renderGeneration += 1;
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }
    if (dimensionObserver) {
      dimensionObserver.disconnect();
    }
    visibleDimensionRows.clear();
    renderedMetaNodes.clear();
    renderedNameNodes.clear();
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
              mediaTypeFor(image) === "image" &&
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
    state.galleryPage = Math.max(0, Math.min(state.galleryPage, Math.ceil(visible.length / MAX_RENDERED_ROWS) - 1));
    const first = state.galleryPage * MAX_RENDERED_ROWS;
    elements["gallery-pagination"].hidden = visible.length <= MAX_RENDERED_ROWS;
    elements["pagination-label"].textContent = `${first + 1}–${Math.min(first + MAX_RENDERED_ROWS, visible.length)} of ${visible.length.toLocaleString()}`;
    elements["previous-page-button"].disabled = state.galleryPage === 0;
    elements["next-page-button"].disabled = first + MAX_RENDERED_ROWS >= visible.length;
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = state.showSelected ? "No files selected" : state.showIgnored ? "Nothing ignored here" : state.images.length ? "No matching media" : "No media found yet";
      const detail = document.createElement("p");
      const ignoredCount = state.images.filter(isImageIgnored).length;
      if (state.showSelected) {
        detail.textContent = "Go back to your collection to select files.";
      } else if (state.showIgnored) {
        detail.textContent = ignoredCount
          ? "No ignored media match this filter."
          : state.ignoredKeys.size
            ? `No ignored media are present on this page. Use Restore all to clear the ${state.ignoredKeys.size.toLocaleString()} stored site rule${state.ignoredKeys.size === 1 ? "" : "s"}.`
            : "No ignored media are present on this page.";
      } else if (state.images.length && ignoredCount === state.images.length) {
        detail.textContent = `All ${ignoredCount.toLocaleString()} media items on this page are ignored. Open Filters, then Ignored to restore them.`;
      } else {
        detail.textContent = state.images.length
          ? "Try a different search or clear your filters to see more of your collection."
          : "Scroll the source page to load more images and videos, or use Find more media to scan automatically.";
      }
      empty.append(title, detail);
      if (hasCollectionFilter() && !state.showSelected) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "secondary-button";
        reset.textContent = "Clear filters";
        reset.addEventListener("click", resetMediaFilters);
        empty.appendChild(reset);
      }
      elements["image-list"].appendChild(empty);
      updateSummary(visible);
      if (focusedKey) elements["selected-label"].focus({ preventScroll: true });
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const image of visible.slice(first, first + MAX_RENDERED_ROWS)) {
      fragment.appendChild(makeImageRow(image));
    }
    elements["image-list"].appendChild(fragment);

    updateSummary(visible);
    if (focusedKey) {
      const target = Array.from(elements["image-list"].querySelectorAll("[data-focus-key]"))
        .find((node) => node.dataset.focusKey === focusedKey && !node.disabled);
      (target || elements["selected-label"]).focus({ preventScroll: true });
    }
  }

  function updateGalleryControls() {
    if (editTrackerId) {
      elements["gallery-status"].textContent = state.pageUrl;
      return;
    }
    const collecting = Boolean(galleryCollection);
    elements["collect-gallery-button"].hidden = collecting;
    elements["collect-gallery-button"].disabled = state.busy || !state.siteKey || !Number.isInteger(state.sourceTabId);
    elements["refresh-media-button"].disabled = collecting || state.busy || !galleryContext || !Number.isInteger(state.sourceTabId);
    elements["stop-gallery-button"].hidden = !collecting;
    elements["clear-gallery-button"].disabled = collecting || state.busy || !state.images.length;
    elements["gallery-undo"].hidden = !clearedGallery || clearedGallery.context !== galleryContext || clearedGallery.epoch !== galleryContext.epoch;
    elements["undo-clear-button"].disabled = collecting || state.busy;
    if (!collecting) {
      elements["gallery-status"].textContent = state.siteKey
        ? `${hostFromUrl(state.siteKey)} · ${state.images.length.toLocaleString()} collected · ${state.incognito ? "private session only" : "saved on this device"}`
        : "Galleries are saved separately for each website.";
    }
  }

  function savedRecord(image) {
    return Gallery.normalizeRecord({
      ...image,
      pageUrl: image.pageUrl || state.pageUrl,
      pageTitle: image.pageTitle || state.pageTitle,
      selected: state.selected.has(image.url)
    }, state.siteKey);
  }

  function scheduleGallerySave() {
    if (state.busy || !galleryContext || galleryContext.siteKey !== state.siteKey) {
      return;
    }
    if (gallerySaveTimer !== null) {
      clearTimeout(gallerySaveTimer);
    }
    gallerySaveTimer = setTimeout(saveCurrentGallery, 200);
  }

  function saveCurrentGallery() {
    if (gallerySaveTimer !== null) {
      clearTimeout(gallerySaveTimer);
      gallerySaveTimer = null;
    }
    const context = galleryContext;
    if (!context || context.siteKey !== state.siteKey || context.incognito !== state.incognito) {
      return galleryWritePromise;
    }
    const records = [];
    const changed = new Map();
    for (const image of state.images) {
      const record = savedRecord(image);
      if (!record) {
        continue;
      }
      const key = Gallery.recordKey(record);
      const serialized = JSON.stringify(record);
      if (context.sent.get(key) !== serialized) {
        records.push(record);
        changed.set(key, { before: context.sent.get(key), after: serialized });
        context.sent.set(key, serialized);
      }
    }
    if (!records.length) {
      return galleryWritePromise;
    }
    context.pending += 1;
    // Send only changed records so another tab's discoveries and selection edits survive.
    galleryWritePromise = browser.runtime.sendMessage({
      type: "SITE_GALLERY", action: "save", siteKey: context.siteKey,
      incognito: context.incognito, epoch: context.epoch, records
    }).then((result) => {
      if (!result || !result.ok) {
        throw new Error(result && result.error || "Firefox could not save the gallery.");
      }
      if (galleryContext === context && result.stale) {
        applySavedGallery(result.gallery);
      } else if (galleryContext === context && result.gallery.trimmed) {
        stopGalleryCollection();
        setNotice("This site's saved gallery reached its item or storage limit. Clear the saved gallery to make room.", "error");
      }
    }).catch((error) => {
      for (const [key, value] of changed) {
        if (context.sent.get(key) === value.after) {
          context.sent.set(key, value.before);
        }
      }
      if (galleryContext === context) {
        setNotice(`Gallery changes are still visible but could not be saved. (${error.message || error})`, "error");
      }
    }).finally(() => { context.pending -= 1; });
    return galleryWritePromise;
  }

  function applySavedGallery(gallery) {
    const context = galleryContext;
    if (!context || gallery.siteKey !== context.siteKey) {
      return;
    }
    if (gallery.epoch !== context.epoch) {
      stopGalleryCollection();
      stopLiveCapture();
      sourcePageGeneration += 1;
      state.images = [];
      state.selected.clear();
      context.sent.clear();
      context.epoch = gallery.epoch;
    }
    const current = new Map(state.images.map((image) => [Gallery.recordKey(image), image]));
    for (const record of gallery.records) {
      const key = Gallery.recordKey(record);
      const existing = current.get(key);
      const local = existing && savedRecord(existing);
      if (!local || JSON.stringify(local) === context.sent.get(key)) {
        const next = { ...record };
        if (existing && Gallery.youtubeUrl(existing) && existing.url !== Gallery.youtubeUrl(existing)) {
          next.url = existing.url;
        }
        if (existing) {
          state.selected.delete(existing.url);
        }
        current.set(key, next);
        if (record.selected && !isImageIgnored(next)) {
          state.selected.add(next.url);
        }
      }
      context.sent.set(key, JSON.stringify(record));
    }
    state.images = accumulateLiveImages([], Array.from(current.values())).images;
    markFilenamePreviewsDirty();
    renderImages();
    refreshDownloadStatuses().catch(() => undefined);
  }

  async function restoreSiteGallery(tab, settings, generation) {
    const siteKey = Core.siteKeyForUrl(tab.url);
    if (!siteKey) {
      return;
    }
    const sameContext = galleryContext && galleryContext.siteKey === siteKey &&
      galleryContext.incognito === Boolean(tab.incognito);
    if (sameContext && settings.live) {
      return;
    }
    if (!sameContext) resetCollectionView();
    await saveCurrentGallery();
    const result = await browser.runtime.sendMessage({
      type: "SITE_GALLERY", action: "get", siteKey, incognito: Boolean(tab.incognito)
    });
    if (!scanSourceStillCurrent(settings, generation)) {
      return;
    }
    if (!result || !result.ok) {
      throw new Error(result && result.error || "Firefox could not restore this website's gallery.");
    }
    const gallery = Gallery.normalizeSite(result.gallery);
    galleryContext = {
      siteKey, incognito: Boolean(tab.incognito), epoch: gallery.epoch, pending: 0,
      sent: new Map(gallery.records.map((record) => [Gallery.recordKey(record), JSON.stringify(record)]))
    };
    state.siteKey = siteKey;
    state.pageUrl = tab.url;
    state.pageTitle = tab.title || hostFromUrl(tab.url);
    state.pageScopeKey = pageScopeKeyForUrl(tab.url);
    state.images = gallery.records;
    state.selected = new TrackedSelectionSet(gallery.records.filter((record) => record.selected).map((record) => record.url));
    state.ignoredKeys = sameContext ? state.ignoredKeys : new Set();
    state.explicitRedownloads.clear();
    state.showIgnored = false;
    state.instagramCollectionFilter = "all";
    state.instagramCollectionMode = state.images.some((image) => image.instagramCollections.length);
    elements["page-label"].textContent = state.pageTitle;
    markFilenamePreviewsDirty();
    renderImages();
  }

  async function clearSiteGallery(options) {
    const context = galleryContext;
    if (!context || state.busy || galleryCollection) {
      return;
    }
    stopLiveCapture();
    const records = state.images.map(savedRecord).filter(Boolean);
    const explicitRedownloads = new Set(state.explicitRedownloads);
    state.busy = true;
    updateSummary();
    await saveCurrentGallery();
    try {
      const result = await browser.runtime.sendMessage({
        type: "SITE_GALLERY", action: "clear", siteKey: context.siteKey, incognito: context.incognito
      });
      if (!result || !result.ok) {
        throw new Error(result && result.error || "Firefox could not clear this gallery.");
      }
      if (galleryContext === context) {
        applySavedGallery(result.gallery);
        clearedGallery = { context, epoch: result.gallery.epoch, records, explicitRedownloads };
        closeMediaFilters();
        setNotice(`Saved media for ${hostFromUrl(context.siteKey)} cleared. Downloaded files and history are kept.`);
        return true;
      }
    } catch (error) {
      setNotice(error.message || String(error), "error");
    } finally {
      state.busy = false;
      renderImages();
      if (!(options && options.refresh) && clearedGallery && clearedGallery.context === galleryContext) {
        elements["undo-clear-button"].focus({ preventScroll: true });
      }
    }
  }

  async function refreshMedia() {
    if (state.busy || galleryCollection || !galleryContext || !Number.isInteger(state.sourceTabId)) return;
    const context = galleryContext;
    const sourceTabId = state.sourceTabId;
    const pageUrl = state.pageUrl;
    const cleared = await clearSiteGallery({ refresh: true });
    if (!cleared || galleryContext !== context || state.sourceTabId !== sourceTabId || state.pageUrl !== pageUrl) return;

    state.explicitRedownloads.clear();
    resetCollectionView();
    const generation = sourcePageGeneration;
    const scanned = await scanPage({ pinnedSource: true });
    if (scanned && generation === sourcePageGeneration) {
      if (!state.scanWarnings.length) {
        setNotice(`Media refreshed. Found ${state.images.length.toLocaleString()} item${state.images.length === 1 ? "" : "s"} on the current page.`, "success");
      }
      await startLiveCapture({ skipInitialScan: true, quiet: true });
    }
  }

  async function undoClearSiteGallery() {
    const undo = clearedGallery;
    if (!undo || state.busy || galleryCollection || undo.context !== galleryContext || undo.epoch !== galleryContext.epoch) return;
    state.busy = true;
    updateSummary();
    try {
      const result = await browser.runtime.sendMessage({ type: "SITE_GALLERY", action: "save",
        siteKey: undo.context.siteKey, incognito: undo.context.incognito, epoch: undo.epoch, records: undo.records });
      if (!result || !result.ok) throw new Error(result && result.error || "Firefox could not restore this collection.");
      if (galleryContext !== undo.context) return;
      if (result.stale) {
        clearedGallery = null;
        applySavedGallery(result.gallery);
        throw new Error("This collection was cleared again in another window. The older collection was not restored.");
      }
      state.explicitRedownloads = new Set(undo.explicitRedownloads);
      applySavedGallery(result.gallery);
      clearedGallery = null;
      setNotice("Website collection and selections restored.", "success");
    } catch (error) {
      setNotice(error.message || String(error), "error");
    } finally {
      state.busy = false;
      renderImages();
      elements["selected-label"].focus({ preventScroll: true });
    }
  }

  function handleGalleryStorageChanges(changes, areaName) {
    if (!galleryContext || areaName !== (state.incognito ? "session" : "local") || !changes[Gallery.STORAGE_KEY]) {
      return;
    }
    const gallery = Gallery.getSite(changes[Gallery.STORAGE_KEY].newValue, state.siteKey);
    if (gallery && ((!state.busy && !galleryContext.pending) || gallery.epoch !== galleryContext.epoch)) {
      applySavedGallery(gallery);
    }
  }

  function stopGalleryCollection() {
    if (galleryCollection) {
      galleryCollection.stopped = true;
      galleryCollection.wake?.();
      elements["gallery-status"].textContent = "Stopping scan; media already found will be kept…";
    }
  }

  async function collectGallery() {
    if (state.busy || galleryCollection || !state.siteKey) {
      return;
    }
    if (!responsiveSurface) {
      await saveCurrentGallery();
      const result = await browser.runtime.sendMessage({
        type: "OPEN_MANAGER_TAB", sourceTabId: state.sourceTabId, collectGallery: true
      });
      if (!result || !result.ok) {
        setNotice(result && result.error || "Firefox could not open the media tab.", "error");
      }
      return;
    }
    const run = {
      stopped: false, tabId: state.sourceTabId, url: state.pageUrl,
      generation: sourcePageGeneration, startedAt: Date.now(), pages: 1
    };
    galleryCollection = run;
    stopLiveCapture();
    updateGalleryControls();
    const current = () => !run.stopped && galleryCollection === run &&
      run.generation === sourcePageGeneration && run.tabId === state.sourceTabId;
    const limitReached = () => state.images.length >= MAX_DISCOVERED_IMAGES ||
      state.images.reduce((total, image) => total + image.url.length + String(image.previewUrl || "").length, 0) >= Core.MAX_BATCH_TOTAL_URL_LENGTH ||
      Date.now() - run.startedAt >= Gallery.MAX_DURATION_MS;
    let reason = "No more media or Next pages were exposed.";
    let nextLinks = [];
    try {
      let stable = 0;
      let lastPosition = "";
      let exhaustedSteps = true;
      let moreClicks = 0;
      for (let step = 0; current() && step < Gallery.MAX_STEPS; step += 1) {
        if (limitReached()) {
          reason = "The collection reached its item, URL, or time limit.";
          break;
        }
        const before = state.images.length;
        const scanned = await scanPage({ preserveSelection: true, quiet: true, pinnedSource: true, live: true });
        if (!current()) {
          break;
        }
        if (!scanned) {
          throw new Error("The source page could not be scanned. Collected media has been kept.");
        }
        const results = await browser.scripting.executeScript({
          target: { tabId: run.tabId }, func: Gallery.scrollPage,
          args: [run.url, moreClicks < 20 && step % 4 === 0, step === 0]
        });
        if (!current()) {
          break;
        }
        const position = results && results[0] && results[0].result;
        if (!position) {
          throw new Error("Firefox could not scroll the source page.");
        }
        nextLinks = position.nextLinks || [];
        const marker = `${position.top}:${position.height}:${state.images.length}`;
        moreClicks += Number(Boolean(position.clickedMore));
        stable = !position.clickedMore && position.bottom && marker === lastPosition && state.images.length === before ? stable + 1 : 0;
        lastPosition = marker;
        elements["gallery-status"].textContent = `Scanning ${hostFromUrl(run.url)} · ${state.images.length.toLocaleString()} media · scrolling page 1`;
        if (stable >= 4) {
          exhaustedSteps = false;
          break;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1200);
          run.wake = () => { clearTimeout(timer); resolve(); };
        });
      }
      if (exhaustedSteps && current()) {
        reason = "Scrolling stopped at the collection safety limit.";
      }
      const visited = new Set([Gallery.pageUrl(run.url)]);
      let nextUrl = nextLinks.filter((value) => typeof value === "string" && value.trim()).map((value) => {
        try { return Gallery.pageUrl(new URL(value, run.url).href); } catch (_error) { return ""; }
      }).find((url) => url && Core.siteKeyForUrl(url) === state.siteKey && !visited.has(url));
      const maxPages = Gallery.MAX_PAGES;
      let fetchedBytes = 0;
      while (current() && nextUrl && run.pages < maxPages && !limitReached()) {
        visited.add(nextUrl);
        elements["gallery-status"].textContent = `Scanning page ${run.pages + 1} · ${state.images.length.toLocaleString()} media`;
        const results = await browser.scripting.executeScript({
          target: { tabId: run.tabId }, func: Gallery.fetchPage, args: [nextUrl, run.url]
        });
        if (!current()) {
          break;
        }
        const page = results && results[0] && results[0].result;
        if (!page || typeof page.html !== "string") {
          throw new Error("Firefox could not read the next gallery page.");
        }
        fetchedBytes += page.bytes;
        if (fetchedBytes > 16 * 1024 * 1024) {
          reason = "Pagination reached the 16 MB total page limit.";
          break;
        }
        const parsed = new DOMParser().parseFromString(page.html, "text/html");
        const base = parsed.querySelector("base") || parsed.head.appendChild(parsed.createElement("base"));
        try { base.href = new URL(base.getAttribute("href") || nextUrl, nextUrl).href; } catch (_error) { base.href = nextUrl; }
        const scan = collectImagesFromPage({
          pageUrl: nextUrl, includeBackgrounds: elements["backgrounds-input"].checked,
          maxImages: MAX_DISCOVERED_IMAGES, maxElements: MAX_SCANNED_ELEMENTS
        }, parsed);
        const merged = mergeScanResults([{ frameId: 0, result: scan }]);
        const previous = state.images;
        const accumulated = accumulateLiveImages(previous, merged.images);
        state.images = accumulated.images;
        state.selected = reconcileGallerySelection(previous, true);
        run.pages += 1;
        markFilenamePreviewsDirty();
        renderImages();
        await saveCurrentGallery();
        if (accumulated.trimmed) {
          reason = "The gallery reached its item or URL limit.";
          break;
        }
        if (!merged.images.length) {
          reason = "The next page exposed no media in its HTML; collection stopped there.";
          break;
        }
        nextUrl = Tracker.extractNextPageUrl(parsed, nextUrl);
        if (visited.has(nextUrl)) {
          reason = "The Next link repeated an already collected page.";
          break;
        }
      }
      if (nextUrl && run.pages >= maxPages) {
        reason = `Stopped at the ${maxPages}-page limit.`;
      }
    } catch (error) {
      reason = error.message || String(error);
    } finally {
      if (galleryCollection === run) {
        galleryCollection = null;
        updateGalleryControls();
        if (run.generation === sourcePageGeneration && run.tabId === state.sourceTabId) {
          await saveCurrentGallery();
          setNotice(`${run.stopped ? "Scan stopped." : reason} Kept ${state.images.length.toLocaleString()} media from ${run.pages} page${run.pages === 1 ? "" : "s"}. Review the selection, then download.`);
          await refreshDownloadStatuses().catch(() => undefined);
          await startLiveCapture({ skipInitialScan: true, quiet: true });
        }
      }
    }
  }

  async function scanPage(options) {
    const settings = Object.assign({
      preserveSelection: false,
      quiet: false,
      pinnedSource: false,
      live: false,
      instagramCollections: false,
      tabId: null,
      sidebarFollow: false,
      sidebarGeneration: null
    }, options || {});
    if (state.busy) {
      return false;
    }
    const scanSourceGeneration = sourcePageGeneration;

    let previousImages = state.images;
    const previousByIdentity = new Map();
    let previousPageScopeKey = state.pageScopeKey;
    let previousSiteKey = state.siteKey;
    let previousIgnoredKeys = new Set(state.ignoredKeys);
    let previousInstagramCollectionMode = state.instagramCollectionMode;
    let scanTab = null;
    let succeeded = false;
    state.liveScanning = Boolean(settings.live);
    state.busy = true;
    if (!settings.preserveSelection && !state.images.length) {
      elements["page-label"].textContent = "Scanning the current page…";
    }
    if (!settings.quiet) {
      setNotice("");
    }
    updateSummary();

    try {
      const tab = await sourceTabForScan(settings);
      if (!tab || typeof tab.id !== "number") {
        throw new Error("No active page was found.");
      }
      scanTab = tab;
      if (!scanSourceStillCurrent(settings, scanSourceGeneration)) {
        return false;
      }
      await restoreSiteGallery(tab, settings, scanSourceGeneration);
      if (!scanSourceStillCurrent(settings, scanSourceGeneration)) {
        return false;
      }
      previousImages = state.images;
      previousPageScopeKey = state.pageScopeKey;
      previousSiteKey = state.siteKey;
      previousIgnoredKeys = new Set(state.ignoredKeys);
      previousInstagramCollectionMode = state.instagramCollectionMode;
      for (const image of previousImages) {
        previousByIdentity.set(mediaIdentityKey(image), image);
      }
      state.sourceTabId = tab.id;
      setIncognitoContext(tab.incognito);
      state.sourceWindowId = Number.isInteger(tab.windowId) ? tab.windowId : null;

      const collectorArgs = [{
        includeBackgrounds: elements["backgrounds-input"].checked,
        maxImages: MAX_DISCOVERED_IMAGES,
        maxElements: MAX_SCANNED_ELEMENTS,
        maxDataUrlLength: 500000,
        maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH
      }];
      let injectionResults = null;
      let usedFrameFallback = false;
      let instagramWarning = "";
      let instagramCollectionSucceeded = false;
      let preservedInstagramFallback = false;
      let fapFolderWarning = "";
      let fapFolderCollectionSucceeded = false;
      let youtubeWarning = "";
      let youtubeCollectionSucceeded = false;
      const instagramPage = Boolean(
        Instagram &&
        typeof Instagram.isInstagramUrl === "function" &&
        typeof collectInstagramMediaFromPage === "function" &&
        Instagram.isInstagramUrl(tab.url)
      );
      const fapFolderPage = Boolean(
        !instagramPage &&
        FapFolder &&
        typeof FapFolder.isSupportedUrl === "function" &&
        typeof collectFapFolderMediaFromPage === "function" &&
        FapFolder.isSupportedUrl(tab.url)
      );

      if (instagramPage) {
        if (settings.instagramCollections) {
          elements["page-label"].textContent = "Collecting Instagram stories and highlights…";
        }
        try {
          const instagramResults = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: collectInstagramMediaFromPage,
            args: [{
              includeProfilePosts: !settings.instagramCollections,
              includeStories: Boolean(settings.instagramCollections),
              includeHighlights: Boolean(settings.instagramCollections),
              maxItems: MAX_DISCOVERED_IMAGES,
              maxDocuments: 32,
              maxDocumentBytes: 4000000,
              maxTotalDocumentBytes: 32000000,
              maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH
            }]
          });
          const firstInstagramResult = instagramResults && instagramResults[0];
          const instagramResult = firstInstagramResult && firstInstagramResult.result;
          if (instagramResult && instagramResult.handled && Array.isArray(instagramResult.images)) {
            injectionResults = instagramResults;
            instagramCollectionSucceeded = Boolean(settings.instagramCollections);
          } else if (settings.instagramCollections) {
            const detail = firstInstagramResult && firstInstagramResult.error
              ? ` (${firstInstagramResult.error})`
              : "";
            instagramWarning = `Instagram stories and highlights could not be collected; the existing results were kept.${detail}`;
          }
        } catch (error) {
          instagramWarning = settings.instagramCollections
            ? `Instagram stories and highlights could not be collected; the existing results were kept. (${error.message || error})`
            : `Instagram-specific collection was unavailable. (${error.message || error})`;
        }
      }

      const instagramRouteKey = instagramPage &&
        Instagram && typeof Instagram.routeKeyForUrl === "function"
        ? Instagram.routeKeyForUrl(tab.url)
        : "";
      if (instagramRouteKey && !settings.instagramCollections && !injectionResults) {
        injectionResults = [{
          frameId: 0,
          result: {
            handled: true,
            pageUrl: tab.url,
            pageTitle: String(tab.title || "Instagram"),
            embeddedFrameCount: 0,
            images: [],
            warnings: [
              instagramWarning ||
              "Instagram did not expose media for this exact route to the current browser session."
            ]
          }
        }];
        instagramWarning = "";
      }

      if (fapFolderPage && !injectionResults) {
        elements["page-label"].textContent = "Inspecting FapFolder video posts…";
        try {
          const fapFolderResults = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: collectFapFolderMediaFromPage,
            args: [{
              maxItems: MAX_DISCOVERED_IMAGES,
              maxPosts: 64,
              maxConcurrency: 3,
              maxDocumentBytes: 2000000,
              maxTotalDocumentBytes: 16000000,
              maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH,
              requestTimeoutMs: 8000
            }]
          });
          const fapFolderResult = fapFolderResults && fapFolderResults[0] &&
            fapFolderResults[0].result;
          if (fapFolderResult && fapFolderResult.handled && Array.isArray(fapFolderResult.images)) {
            injectionResults = fapFolderResults;
            fapFolderCollectionSucceeded = fapFolderResult.images.some((image) =>
              image && image.mediaType === "video"
            );
          }
        } catch (error) {
          fapFolderWarning = `FapFolder post inspection was unavailable; the visible page was scanned instead. (${error.message || error})`;
        }
      }

      const youtubePage = Boolean(
        !instagramPage &&
        !fapFolderPage &&
        YouTube &&
        typeof YouTube.isYouTubeUrl === "function" &&
        typeof collectYouTubeMediaFromPage === "function" &&
        YouTube.isYouTubeUrl(tab.url) &&
        /(?:[?&]v=[A-Za-z0-9_-]{11}(?:[&#]|$)|\/(?:embed|live|shorts|v)\/[A-Za-z0-9_-]{11}(?:[/?#]|$)|youtu\.be\/[A-Za-z0-9_-]{11}(?:[/?#]|$))/i.test(String(tab.url || ""))
      );

      const youtubeVideoIdMatch = String(tab.url || "").match(
        /(?:[?&]v=|\/(?:embed|live|shorts|v)\/|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[/?&#]|$)/i
      );
      const youtubeVideoId = youtubeVideoIdMatch ? youtubeVideoIdMatch[1] : "";
      const reusableYouTubeResults = Boolean(
        youtubePage &&
        settings.live &&
        youtubeVideoId &&
        previousImages.some((image) =>
          image && image.sourceProvider === "youtube" && image.videoId === youtubeVideoId
        )
      );
      if (reusableYouTubeResults) {
        injectionResults = [{
          frameId: 0,
          result: {
            handled: true,
            pageUrl: tab.url,
            pageTitle: state.pageTitle || String(tab.title || ""),
            embeddedFrameCount: 0,
            images: previousImages.filter((image) => image && image.sourceProvider === "youtube"),
            warnings: state.scanWarnings
          }
        }];
        youtubeCollectionSucceeded = true;
      }

      if (youtubePage && !injectionResults) {
        elements["page-label"].textContent = "Resolving a direct YouTube video file…";
        try {
          const youtubeResults = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: collectYouTubeMediaFromPage,
            args: [{
              includeVideoOnly: false,
              maxFormats: 24,
              maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH,
              maxResponses: 8,
              maxScripts: 160,
              maxScriptBytes: 4000000,
              maxTotalScriptBytes: 12000000,
              maxResponseBytes: 8000000,
              requestTimeoutMs: 8000
            }]
          });
          const youtubeResult = youtubeResults && youtubeResults[0] && youtubeResults[0].result;
          if (youtubeResult && youtubeResult.handled && Array.isArray(youtubeResult.images)) {
            injectionResults = youtubeResults;
            youtubeCollectionSucceeded = youtubeResult.images.some((image) =>
              image && image.mediaType === "video"
            );
          }
        } catch (error) {
          youtubeWarning = `YouTube-specific collection was unavailable; the visible page was scanned instead. (${error.message || error})`;
        }
      }

      if (settings.instagramCollections && !injectionResults) {
        const previousMatchesTab = previousPageScopeKey &&
          pageScopeKeyForUrl(tab.url) === previousPageScopeKey;
        injectionResults = [{
          frameId: 0,
          result: {
            pageUrl: tab.url,
            pageTitle: previousMatchesTab ? state.pageTitle : String(tab.title || ""),
            embeddedFrameCount: 0,
            images: previousMatchesTab ? previousImages : [],
            warnings: []
          }
        }];
        preservedInstagramFallback = previousMatchesTab;
      }

      if (!injectionResults) {
        try {
          injectionResults = await browser.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: collectImagesFromPage,
            args: collectorArgs
          });
        } catch (_frameError) {
          usedFrameFallback = true;
          injectionResults = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: collectImagesFromPage,
            args: collectorArgs
          });
        }
      }
      if (!scanSourceStillCurrent(settings, scanSourceGeneration)) {
        return false;
      }

      const merged = mergeScanResults(injectionResults);
      if (!merged.page) {
        throw new Error("The page did not return scan results.");
      }
      if (usedFrameFallback) {
        merged.warnings.push("Some embedded frames could not be inspected; the main page was scanned.");
      }
      if (instagramWarning) {
        merged.warnings.push(instagramWarning);
      }
      if (fapFolderWarning) {
        merged.warnings.push(fapFolderWarning);
      }
      if (youtubeWarning) {
        merged.warnings.push(youtubeWarning);
      }

      const nextSiteKey = Core.siteKeyForUrl(merged.page.pageUrl);
      const nextPageScopeKey = pageScopeKeyForUrl(merged.page.pageUrl);
      const preserveThisPage = Boolean(nextSiteKey) && nextSiteKey === previousSiteKey;
      state.siteKey = nextSiteKey;
      state.pageScopeKey = nextPageScopeKey;
      if (!preserveThisPage) {
        state.instagramCollectionFilter = "all";
      }
      try {
        await loadIgnoredKeys();
      } catch (error) {
        state.ignoredKeys = preserveThisPage ? previousIgnoredKeys : new Set();
        merged.warnings.push(`Firefox could not load ignored-media rules: ${error.message || error}`);
      }
      if (!scanSourceStillCurrent(settings, scanSourceGeneration)) {
        return false;
      }

      if (preserveThisPage) {
        for (const image of merged.images) {
          const previous = previousByIdentity.get(mediaIdentityKey(image));
          if (!previous || image.originalMediaType === 1) {
            continue;
          }
          image.width = image.width || previous.width || 0;
          image.height = image.height || previous.height || 0;
          image.duration = image.duration || previous.duration || 0;
          image.mimeType = image.mimeType || previous.mimeType || "";
          image.filename = image.filename || previous.filename || "";
          image.sourceProvider = image.sourceProvider || previous.sourceProvider || "";
          image.videoId = image.videoId || previous.videoId || "";
          image.qualityLabel = image.qualityLabel || previous.qualityLabel || "";
          if (image.hasAudio === null || image.hasAudio === undefined) {
            image.hasAudio = previous.hasAudio;
          }
          image.itag = image.itag || previous.itag || 0;
          image.previewUrl = image.previewUrl || previous.previewUrl || "";
          if ((!image.width || !image.height) && previous.dimensionStatus) {
            image.dimensionStatus = previous.dimensionStatus;
          } else if (image.width && image.height) {
            image.dimensionStatus = "known";
          }
        }
      }

      const discoveredImages = preservedInstagramFallback ? [] : merged.images;
      if (settings.instagramCollections && preserveThisPage) {
        const accumulated = accumulateLiveImages(previousImages, merged.images, {
          maxImages: MAX_DISCOVERED_IMAGES,
          maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH
        });
        if (accumulated.trimmed) {
          merged.warnings.push("Instagram collection results reached the 1,500-item or 2 MB safety limit.");
        }
        merged.images = accumulated.images;
      } else if (preserveThisPage) {
        const accumulated = accumulateLiveImages(previousImages, merged.images, {
          maxImages: MAX_DISCOVERED_IMAGES,
          maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH
        });
        if (accumulated.trimmed) {
          merged.warnings.push("Automatic live updates reached the 1,500-item or 2 MB safety limit.");
        }
        merged.images = accumulated.images;
      }

      state.images = merged.images;
      markFilenamePreviewsDirty();
      state.selected = reconcileGallerySelection(previousImages, preserveThisPage);
      state.scanWarnings = merged.warnings;
      state.pageTitle = merged.page.pageTitle || "";
      state.pageUrl = merged.page.pageUrl || "";
      state.instagramCollectionMode = Boolean(
        instagramCollectionSucceeded ||
        (preserveThisPage && previousInstagramCollectionMode) ||
        (settings.instagramCollections && preservedInstagramFallback && previousInstagramCollectionMode)
      );
      updateInstagramCollectionFilterUi();
      const hostname = hostFromUrl(merged.page.pageUrl);
      elements["page-label"].textContent = merged.page.pageTitle || hostname;
      updateFilenameTemplateUi();
      if (settings.live) {
        renderImages();
      }

      try {
        await refreshDownloadStatuses({ render: false });
      } catch (error) {
        merged.warnings.push(`Completed-download status is temporarily unavailable: ${error.message || error}`);
      }

      if (!state.hasStoredFolder) {
        const safeHost = Core.sanitizePathSegment(hostname, "page");
        elements["folder-input"].value = `${Core.DEFAULT_FOLDER}/${safeHost}`;
      }

      const addedCount = preserveThisPage
        ? merged.images.filter((image) => !previousByIdentity.has(mediaIdentityKey(image))).length
        : 0;
      if (settings.live && addedCount) {
        setNotice(
          `Automatic live updates added ${addedCount.toLocaleString()} new media item${addedCount === 1 ? "" : "s"}. Keep scrolling to load more.`,
          "success"
        );
      } else if (instagramCollectionSucceeded && merged.images.length && !merged.warnings.length) {
        setNotice(
          "Collected the active story and available highlights with the current Instagram session.",
          "success"
        );
      } else if (fapFolderCollectionSucceeded && !merged.warnings.length) {
        setNotice(
          `Found ${merged.images.length.toLocaleString()} direct video file${merged.images.length === 1 ? "" : "s"} inside the loaded FapFolder posts.`,
          "success"
        );
      } else if (youtubeCollectionSucceeded && !merged.warnings.length) {
        setNotice(
          `Found ${merged.images.length.toLocaleString()} complete YouTube video file${merged.images.length === 1 ? "" : "s"} with audio.`,
          "success"
        );
      } else if (merged.warnings.length) {
        setNotice(merged.warnings.join(" "));
      } else if (!merged.images.length) {
        setNotice("No downloadable media is currently exposed on this page. Automatic live updates will keep watching for it.");
      }
      succeeded = true;
    } catch (error) {
      if (!scanSourceStillCurrent(settings, scanSourceGeneration)) {
        return false;
      }
      if (!settings.preserveSelection && !galleryContext) {
        state.images = [];
        markFilenamePreviewsDirty();
        state.selected.clear();
        state.explicitRedownloads.clear();
        downloadStatusGeneration += 1;
        state.siteKey = "";
        state.ignoredKeys.clear();
        state.sourceWindowId = null;
        state.pageTitle = "";
        state.pageUrl = "";
        state.pageScopeKey = "";
        state.instagramCollectionFilter = "all";
        state.instagramCollectionMode = false;
        updateInstagramCollectionFilterUi();
        elements["page-label"].textContent = "This page cannot be scanned";
      }
      const message = error && error.message ? error.message : String(error);
      if (sidebarMode && scanTab && !isNormalSidebarTab(scanTab)) {
        showProtectedSidebarPage(scanTab);
      } else if (sidebarMode && !state.sidebarHasBroadAccess) {
        revealSidebarFollowPermission();
        setNotice(
          `AnyDownload needs site access to follow this tab automatically. Click Enable auto-follow, or reopen AnyDownload on this page for one-time access. (${message})`,
          "error"
        );
      } else {
        const guidance = Number.isInteger(state.sourceTabId)
          ? sidebarMode
            ? "Firefox could not inspect the active page. Wait for it to finish loading; automatic updates will retry after the page changes."
            : "The source tab is unavailable, navigated, or no longer grants temporary access. Return to the page and click AnyDownload again."
          : "Firefox blocks scanning on internal pages, its PDF viewer, and protected Mozilla pages. Open a normal website and try again.";
        setNotice(`${guidance} (${message})`, "error");
      }
    } finally {
      state.liveScanning = false;
      state.busy = false;
      renderImages();
      if (succeeded) {
        await saveCurrentGallery();
      }
      if (succeeded && state.trackerPageUrl !== state.pageUrl) {
        refreshTrackerStatus().catch((error) => {
          console.error("AnyDownload could not load the tracker for this page.", error);
          updateTrackerUi();
        });
      } else {
        updateTrackerUi();
      }
    }
    return succeeded;
  }

  async function requestDownloads(images, options) {
    const settings = Object.assign({ allowRedownload: false }, options || {});
    images = images.filter((image) => {
      const status = downloadStatusFor(image);
      const redownloadAllowed = settings.allowRedownload ||
        Boolean(image.downloadFingerprint) && state.explicitRedownloads.has(image.downloadFingerprint);
      return status !== "queued" &&
        (status !== "downloaded" || redownloadAllowed) &&
        !isImageIgnored(image);
    });
    if (state.busy || !images.length) {
      if (!state.busy) {
        setNotice("No downloadable media files are selected.", "error");
      }
      return;
    }
    const folder = folderStatus();
    if (!folder.ok) {
      elements["download-settings-panel"].showPopover();
      elements["folder-input"].focus();
      updateSummary();
      return;
    }
    const template = requireValidFilenameTemplate();
    if (!template) {
      return;
    }

    let youtubePermissionPromise = Promise.resolve(true);
    if (images.some((image) => image && image.sourceProvider === "youtube")) {
      if (!browser.permissions || typeof browser.permissions.request !== "function") {
        setNotice("This Firefox build cannot grant the YouTube access needed to refresh expiring video links.", "error");
        return;
      }
      try {
        // Keep this call in the direct click stack. The durable queue stores a
        // public video ID and refreshes the expiring file URL on start/retry.
        youtubePermissionPromise = browser.permissions.request({
          origins: ["https://www.youtube.com/*"]
        });
      } catch (error) {
        setNotice(`Firefox could not request YouTube access. (${error.message || error})`, "error");
        return;
      }
    }

    state.busy = true;
    setNotice(
      images.some((image) => image && image.sourceProvider === "youtube")
        ? "Allow access to YouTube so expiring video links can be refreshed when the queue starts or retries."
        : `Adding ${images.length.toLocaleString()} download${images.length === 1 ? "" : "s"} to the queue…`
    );
    renderImages();

    try {
      if (!await youtubePermissionPromise) {
        throw new Error("YouTube access was not granted, so no video was queued.");
      }
      const storedSettings = {
        askForSingle: elements["ask-single-input"].checked,
        includeBackgrounds: elements["backgrounds-input"].checked,
        filenameTemplate: template.value
      };
      if (!state.incognito) {
        storedSettings.destinationFolder = folder.value;
      }
      await persistSettings(storedSettings);
      await loadIgnoredKeys();
      for (const image of state.images) {
        if (isImageIgnored(image)) {
          state.selected.delete(image.url);
        }
      }
      images = images.filter((image) => {
        const status = downloadStatusFor(image);
        const redownloadAllowed = settings.allowRedownload ||
          Boolean(image.downloadFingerprint) && state.explicitRedownloads.has(image.downloadFingerprint);
        return status !== "queued" &&
          (status !== "downloaded" || redownloadAllowed) &&
          !isImageIgnored(image);
      });
      if (!images.length) {
        setNotice("No downloadable media files are selected.", "error");
        return;
      }
      state.hasStoredFolder = true;
      const downloadItems = renderedDownloadItems(images, template.value);
      const result = await browser.runtime.sendMessage({
        type: "DOWNLOAD_BATCH",
        folder: folder.value,
        saveAs: elements["ask-single-input"].checked && images.length === 1,
        incognito: state.incognito,
        pageTitle: state.pageTitle,
        pageUrl: state.pageUrl,
        items: downloadItems
      });

      if (!result || !result.ok) {
        const firstError = result && result.errors && result.errors[0] && result.errors[0].error;
        throw new Error((result && result.error) || firstError || "Firefox did not start the downloads.");
      }

      const queueNotice = downloadBatchNotice(result);
      if (queueNotice) {
        setNotice(queueNotice.message, queueNotice.type);
      } else {
        const firstError = result.errors && result.errors[0] ? ` First problem: ${result.errors[0].error}` : "";
        const message = result.failed
          ? `Started ${result.started.toLocaleString()} of ${result.total.toLocaleString()} downloads. ${result.failed.toLocaleString()} could not be started.${firstError}`
          : `Started ${result.started.toLocaleString()} download${result.started === 1 ? "" : "s"} in Downloads/${result.folder}.`;
        setNotice(message, result.failed ? "error" : "success");
      }
      const acceptedIndexes = Array.isArray(result.acceptedIndexes)
        ? result.acceptedIndexes
        : images.map((_image, index) => index);
      for (const index of acceptedIndexes) {
        const image = images[index];
        if (!image) {
          continue;
        }
        state.selected.delete(image.url);
        if (image.downloadFingerprint) {
          state.explicitRedownloads.delete(image.downloadFingerprint);
        }
        image.downloadStatus = "queued";
      }
      await refreshDownloadStatuses({ render: false }).catch(() => undefined);
      refreshQueueBadge();
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      state.busy = false;
      renderImages();
    }
  }

  function downloadSelectedImages() {
    return requestDownloads(selectedDownloadableImages());
  }

  async function uploadSelectedImages() {
    if (state.incognito || state.busy || galleryCollection) return;
    const images = selectedDownloadableImages();
    if (!images.length || images.length > 500 || images.some((item) => mediaTypeFor(item) !== "image")) {
      setNotice("Choose between 1 and 500 images to upload.", "error");
      return;
    }
    const template = requireValidFilenameTemplate();
    if (!template) return;
    const id = createPreviewId();
    const key = `uploadJobRequest:${id}`;
    state.busy = true;
    updateSummary();
    try {
      await browser.storage.session.set({ [key]: {
        createdAt: Date.now(), incognito: false,
        items: renderedDownloadItems(images, template.value).map(({ url, filename }) => ({ url, filename }))
      } });
      showWorkspace("upload", `request=${encodeURIComponent(id)}`);
    } catch (_error) {
      await browser.storage.session.remove(key).catch(() => undefined);
      setNotice("Firefox could not open Uploads. Please try again.", "error");
    } finally {
      state.busy = false;
      updateSummary();
    }
  }

  async function finishArchiveDownload(images, folder, permissionPromise, templateValue) {
    try {
      const granted = await permissionPromise;
      if (!granted) {
        throw new Error("Site access was not granted, so no archive was created.");
      }

      setNotice(
        `Preparing Archive Progress for ${images.length.toLocaleString()} original image${images.length === 1 ? "" : "s"}…`
      );
      const storedSettings = {
        askForSingle: elements["ask-single-input"].checked,
        includeBackgrounds: elements["backgrounds-input"].checked,
        filenameTemplate: templateValue
      };
      if (!state.incognito) {
        storedSettings.destinationFolder = folder.value;
      }
      await persistSettings(storedSettings);
      await loadIgnoredKeys();
      for (const image of state.images) {
        if (isImageIgnored(image)) {
          state.selected.delete(image.url);
        }
      }
      images = images.filter((image) =>
        mediaTypeFor(image) === "image" &&
        !isImageIgnored(image)
      );
      if (!images.length) {
        throw new Error("No non-ignored images are selected.");
      }

      state.hasStoredFolder = true;
      const archiveItems = renderedDownloadItems(images, templateValue);
      const jobId = createPreviewId();
      const storageKey = `archiveJobRequest:${jobId}`;
      await browser.storage.session.set({
        [storageKey]: {
          createdAt: Date.now(),
          folder: folder.value,
          incognito: state.incognito,
          pageTitle: state.pageTitle,
          pageUrl: state.pageUrl,
          items: archiveItems
        }
      });

      const archiveUrl = browser.runtime.getURL(
        `archive/archive.html?job=${encodeURIComponent(jobId)}`
      );
      const createProperties = { url: archiveUrl, active: true };
      if (Number.isInteger(state.sourceWindowId)) {
        createProperties.windowId = state.sourceWindowId;
      }
      try {
        await browser.tabs.create(createProperties);
      } catch (error) {
        await browser.storage.session.remove(storageKey).catch(() => undefined);
        throw error;
      }
      setNotice(
        `Opened Archive Progress for ${images.length.toLocaleString()} selected image${images.length === 1 ? "" : "s"}.`,
        "success"
      );
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      state.busy = false;
      renderImages();
    }
  }

  function downloadSelectedArchive() {
    const selected = selectedDownloadableImages();
    if (state.busy || !selected.length) {
      if (!state.busy) {
        setNotice("No non-ignored images are selected.", "error");
      }
      return undefined;
    }
    if (selected.some((item) => mediaTypeFor(item) === "video")) {
      setNotice("ZIP archives currently support images only. Clear the selected videos and try again.", "error");
      return undefined;
    }
    const images = selected;
    if (images.length > 2000) {
      setNotice("Choose at most 2,000 images for one ZIP archive.", "error");
      return undefined;
    }

    const folder = folderStatus();
    if (!folder.ok) {
      elements["download-settings-panel"].showPopover();
      elements["folder-input"].focus();
      updateSummary();
      return undefined;
    }
    const template = requireValidFilenameTemplate();
    if (!template) {
      return undefined;
    }

    const origins = hostPermissionPatternsForImages(images);
    let permissionPromise = Promise.resolve(true);
    if (origins.length) {
      if (!browser.permissions || typeof browser.permissions.request !== "function") {
        setNotice("This Firefox build cannot grant the site access needed to create an archive.", "error");
        return undefined;
      }
      try {
        // Keep this request in the direct click stack: Firefox permits optional
        // host access only while handling an explicit user action.
        permissionPromise = browser.permissions.request({ origins });
      } catch (error) {
        setNotice(`Firefox could not request access to the selected image sites. (${error.message || error})`, "error");
        return undefined;
      }
    }

    state.busy = true;
    setNotice(
      origins.length
        ? "Allow access to the selected image sites to build the ZIP locally."
        : "Building the ZIP locally…"
    );
    renderImages();
    return finishArchiveDownload(images, folder, permissionPromise, template.value);
  }

  function updateInstagramCollectionsButton() {
    const button = elements["instagram-collections-button"];
    if (!button) {
      return;
    }
    let instagramPage = false;
    try {
      instagramPage = Boolean(
        Instagram &&
        typeof Instagram.canCollectRelated === "function" &&
        Instagram.canCollectRelated(state.pageUrl)
      );
    } catch (_error) {
      instagramPage = false;
    }
    button.hidden = !instagramPage;
    button.disabled = state.busy;
    button.textContent = state.instagramCollectionMode
      ? "Refresh stories & highlights"
      : "Stories & highlights";
  }

  function stopLiveCapture(message, type) {
    state.liveCapture = false;
    liveCaptureGeneration += 1;
    liveFingerprint = "";
    liveLastFullScanAt = 0;
    liveRetryNoticeText = "";
    if (liveCaptureTimer !== null) {
      clearTimeout(liveCaptureTimer);
      liveCaptureTimer = null;
    }
    updateSummary();
    if (message) {
      setNotice(message, type);
    }
  }

  async function liveFingerprintForSource() {
    if (!Number.isInteger(state.sourceTabId)) {
      throw new Error("No source tab is available for automatic updates.");
    }
    const results = await browser.scripting.executeScript({
      target: { tabId: state.sourceTabId },
      func: collectLiveGalleryFingerprint,
      args: [{ maxElements: 2500 }]
    });
    const value = results && results[0] && results[0].result;
    if (!value || typeof value.fingerprint !== "string") {
      throw new Error("The page did not return a live-gallery fingerprint.");
    }
    return value;
  }

  function scheduleLiveCapturePoll(generation, delay) {
    if (!state.liveCapture || generation !== liveCaptureGeneration) {
      return;
    }
    if (liveCaptureTimer !== null) {
      clearTimeout(liveCaptureTimer);
    }
    liveCaptureTimer = setTimeout(() => {
      liveCaptureTimer = null;
      pollLiveCapture(generation);
    }, delay == null ? LIVE_CAPTURE_INTERVAL_MS : delay);
  }

  async function pollLiveCapture(generation) {
    if (!state.liveCapture || generation !== liveCaptureGeneration) {
      return;
    }
    if (state.busy) {
      scheduleLiveCapturePoll(generation);
      return;
    }

    try {
      const fingerprint = await liveFingerprintForSource();
      if (!state.liveCapture || generation !== liveCaptureGeneration) {
        return;
      }
      if (liveRetryNoticeText && !state.busy) {
        if (elements["notice"].textContent === liveRetryNoticeText) {
          setNotice("");
        }
        liveRetryNoticeText = "";
      }
      if (state.busy) {
        scheduleLiveCapturePoll(generation);
        return;
      }
      const now = Date.now();
      const changed = Boolean(liveFingerprint && fingerprint.fingerprint !== liveFingerprint);
      const observedPageScopeKey = pageScopeKeyForUrl(fingerprint.pageUrl);
      const scopeChanged = Boolean(
        observedPageScopeKey &&
        state.pageScopeKey &&
        observedPageScopeKey !== state.pageScopeKey
      );
      const instagramPage = Boolean(
        Instagram &&
        typeof Instagram.isInstagramUrl === "function" &&
        Instagram.isInstagramUrl(state.pageUrl)
      );
      const forceScan = !instagramPage && now - liveLastFullScanAt >= LIVE_FORCE_SCAN_MS;
      if (changed || scopeChanged || forceScan) {
        const scanned = await scanPage({
          preserveSelection: true,
          quiet: true,
          pinnedSource: true,
          live: true
        });
        if (!scanned) {
          if (state.liveCapture && generation === liveCaptureGeneration) {
            scheduleLiveCapturePoll(generation, LIVE_RETRY_INTERVAL_MS);
          }
          return;
        }
        liveLastFullScanAt = Date.now();
      }
      liveFingerprint = fingerprint.fingerprint;
      scheduleLiveCapturePoll(generation);
    } catch (error) {
      if (!state.liveCapture || generation !== liveCaptureGeneration) {
        return;
      }
      liveRetryNoticeText =
        `Automatic live updates are temporarily unavailable and will retry. (${error.message || error})`;
      setNotice(liveRetryNoticeText, "error");
      scheduleLiveCapturePoll(generation, LIVE_RETRY_INTERVAL_MS);
    }
  }

  async function startLiveCapture(options) {
    if (state.liveCapture) {
      if (liveCaptureTimer === null) {
        scheduleLiveCapturePoll(liveCaptureGeneration);
      }
      return true;
    }
    if (!Number.isInteger(state.sourceTabId)) {
      return false;
    }

    state.liveCapture = true;
    liveCaptureGeneration += 1;
    const generation = liveCaptureGeneration;
    if (!options || !options.quiet) {
      setNotice("Automatic live updates are on. Newly exposed media will appear here.", "success");
    }

    try {
      if (!options || !options.skipInitialScan) {
        const scanned = await scanPage({
          preserveSelection: true,
          quiet: true,
          pinnedSource: true,
          live: true
        });
        if (!scanned) {
          stopLiveCapture();
          return false;
        }
      }
      if (!state.liveCapture || generation !== liveCaptureGeneration) {
        return;
      }
      const fingerprint = await liveFingerprintForSource();
      if (!state.liveCapture || generation !== liveCaptureGeneration) {
        return;
      }
      liveFingerprint = fingerprint.fingerprint;
      liveLastFullScanAt = Date.now();
      scheduleLiveCapturePoll(generation);
      return true;
    } catch (error) {
      if (!state.liveCapture || generation !== liveCaptureGeneration) {
        return false;
      }
      liveRetryNoticeText =
        `Automatic live updates are temporarily unavailable and will retry. (${error.message || error})`;
      setNotice(liveRetryNoticeText, "error");
      scheduleLiveCapturePoll(generation, LIVE_RETRY_INTERVAL_MS);
      return true;
    }
  }

  async function collectInstagramCollections() {
    if (!window.confirm(
      "Collect the profile owner's active story and exposed highlights? Instagram may record story access as a view."
    )) {
      return;
    }
    await scanPage({ instagramCollections: true, preserveSelection: true });
  }

  function cancelScheduledSidebarFollow() {
    sidebarFollowGeneration += 1;
    sidebarFollowRequest = null;
    if (sidebarFollowTimer !== null) {
      clearTimeout(sidebarFollowTimer);
      sidebarFollowTimer = null;
    }
  }

  function beginSidebarTransition(tabId, tab) {
    saveCurrentGallery();
    stopGalleryCollection();
    cancelScheduledSidebarFollow();
    sourcePageGeneration += 1;
    if (state.liveCapture) {
      stopLiveCapture();
    }
    state.sourceTabId = Number.isInteger(tabId) ? tabId : null;
    state.sourceWindowId = tab && Number.isInteger(tab.windowId) ? tab.windowId : null;
    if (tab) {
      setIncognitoContext(tab.incognito);
    }
    if (tab && !isNormalSidebarTab(tab)) {
      showProtectedSidebarPage(tab);
    } else {
      showSidebarLoading(tab);
    }
    return sidebarFollowGeneration;
  }

  function scheduleSidebarFollowScan(tabId, delay) {
    if (!sidebarMode || !Number.isInteger(tabId)) {
      return;
    }
    cancelScheduledSidebarFollow();
    if (state.liveCapture) {
      stopLiveCapture();
    }
    state.sourceTabId = tabId;
    const request = {
      generation: sidebarFollowGeneration,
      tabId
    };
    sidebarFollowRequest = request;
    sidebarFollowTimer = setTimeout(() => {
      sidebarFollowTimer = null;
      runSidebarFollowScan(request);
    }, delay == null ? SIDEBAR_SCAN_DEBOUNCE_MS : delay);
  }

  function retrySidebarFollowScan(request) {
    if (
      request !== sidebarFollowRequest ||
      request.generation !== sidebarFollowGeneration ||
      sidebarFollowTimer !== null
    ) {
      return;
    }
    sidebarFollowTimer = setTimeout(() => {
      sidebarFollowTimer = null;
      runSidebarFollowScan(request);
    }, SIDEBAR_SCAN_DEBOUNCE_MS);
  }

  async function runSidebarFollowScan(request) {
    if (
      request !== sidebarFollowRequest ||
      request.generation !== sidebarFollowGeneration
    ) {
      return;
    }
    if (sidebarFollowRunning || state.busy) {
      retrySidebarFollowScan(request);
      return;
    }

    sidebarFollowRunning = true;
    try {
      const tab = await browser.tabs.get(request.tabId);
      if (
        request !== sidebarFollowRequest ||
        request.generation !== sidebarFollowGeneration
      ) {
        return;
      }
      if (
        !tab.active ||
        !Number.isInteger(state.sidebarWindowId) ||
        tab.windowId !== state.sidebarWindowId
      ) {
        return;
      }
      state.sourceTabId = tab.id;
      state.sourceWindowId = tab.windowId;
      setIncognitoContext(tab.incognito);
      if (!isNormalSidebarTab(tab)) {
        showProtectedSidebarPage(tab);
        return;
      }
      if (tab.status === "loading") {
        showSidebarLoading(tab);
        return;
      }
      const scanned = await scanPage({
        tabId: tab.id,
        sidebarFollow: true,
        sidebarGeneration: request.generation
      });
      if (scanned && request.generation === sidebarFollowGeneration) {
        await startLiveCapture({ skipInitialScan: true, quiet: true });
      }
    } catch (error) {
      if (
        request === sidebarFollowRequest &&
        request.generation === sidebarFollowGeneration
      ) {
        resetSidebarPageState(
          "The active tab is unavailable",
          `Firefox could not read the active tab. The sidebar will retry when its page changes. (${error.message || error})`,
          "error"
        );
      }
    } finally {
      sidebarFollowRunning = false;
      if (request === sidebarFollowRequest) {
        sidebarFollowRequest = null;
      }
    }
  }

  async function handleSidebarTabActivated(activeInfo) {
    if (
      !sidebarMode ||
      !Number.isInteger(state.sidebarWindowId) ||
      activeInfo.windowId !== state.sidebarWindowId
    ) {
      return;
    }

    const generation = beginSidebarTransition(activeInfo.tabId, null);
    try {
      const tab = await browser.tabs.get(activeInfo.tabId);
      if (
        generation !== sidebarFollowGeneration ||
        tab.id !== state.sourceTabId ||
        tab.windowId !== state.sidebarWindowId ||
        !tab.active
      ) {
        return;
      }
      state.sourceWindowId = tab.windowId;
      setIncognitoContext(tab.incognito);
      if (!isNormalSidebarTab(tab)) {
        showProtectedSidebarPage(tab);
      } else if (tab.status === "loading") {
        showSidebarLoading(tab);
      } else {
        scheduleSidebarFollowScan(tab.id);
      }
    } catch (error) {
      if (generation === sidebarFollowGeneration) {
        resetSidebarPageState(
          "The active tab is unavailable",
          `Firefox could not read the active tab. (${error.message || error})`,
          "error"
        );
      }
    }
  }

  async function scanCurrentSidebarTab() {
    const query = { active: true };
    if (Number.isInteger(state.sidebarWindowId)) {
      query.windowId = state.sidebarWindowId;
    } else {
      query.currentWindow = true;
    }
    const tabs = await browser.tabs.query(query);
    const tab = tabs[0];
    if (!tab) {
      resetSidebarPageState("No active page", "No active page was found in this Firefox window.", "error");
      return;
    }
    if (!Number.isInteger(state.sidebarWindowId) && Number.isInteger(tab.windowId)) {
      state.sidebarWindowId = tab.windowId;
    }
    setIncognitoContext(tab.incognito);
    if (!isNormalSidebarTab(tab)) {
      beginSidebarTransition(tab.id, tab);
      return;
    }
    if (tab.status === "loading") {
      beginSidebarTransition(tab.id, tab);
      return;
    }
    scheduleSidebarFollowScan(tab.id, 0);
  }

  async function requestSidebarFollowPermission() {
    const button = elements["sidebar-follow-button"];
    if (!sidebarMode || !button) {
      return;
    }
    button.disabled = true;
    try {
      const granted = await browser.permissions.request(SIDEBAR_ALL_URLS_PERMISSION);
      state.sidebarHasBroadAccess = Boolean(granted);
      state.sidebarPermissionNeeded = !granted;
      updateSidebarFollowButton();
      if (!granted) {
        setNotice(
          "Site access was not granted. The sidebar can still scan pages opened through AnyDownload, but it cannot follow every tab automatically.",
          "error"
        );
        return;
      }
      setNotice("Automatic sidebar updates are enabled for normal websites.", "success");
      await scanCurrentSidebarTab();
    } catch (error) {
      state.sidebarPermissionNeeded = true;
      updateSidebarFollowButton();
      setNotice(`Firefox could not request site access. (${error.message || error})`, "error");
    } finally {
      if (!button.hidden) {
        button.disabled = false;
      }
    }
  }

  function scheduleSourceRescan(generation) {
    if (sourceRescanTimer !== null) {
      clearTimeout(sourceRescanTimer);
    }
    sourceRescanTimer = setTimeout(async () => {
      sourceRescanTimer = null;
      if (generation !== sourcePageGeneration) {
        return;
      }
      if (state.busy) {
        scheduleSourceRescan(generation);
        return;
      }
      const scanned = await scanPage({ pinnedSource: true, preserveSelection: true });
      if (scanned && generation === sourcePageGeneration) {
        await startLiveCapture({ skipInitialScan: true, quiet: true });
      }
    }, SIDEBAR_SCAN_DEBOUNCE_MS);
  }

  function wireSourceTabLifecycle() {
    if (browser.tabs && browser.tabs.onRemoved) {
      browser.tabs.onRemoved.addListener((tabId) => {
        if (tabId !== state.sourceTabId) {
          return;
        }
        saveCurrentGallery();
        stopGalleryCollection();
        sourcePageGeneration += 1;
        if (sidebarMode) {
          cancelScheduledSidebarFollow();
          if (state.liveCapture) {
            stopLiveCapture();
          }
          state.sourceTabId = null;
          state.sourceWindowId = null;
        } else if (state.liveCapture) {
          stopLiveCapture("Automatic live updates stopped because the source tab was closed.", "error");
        }
      });
    }
    if (browser.tabs && browser.tabs.onUpdated) {
      browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (
          sidebarMode &&
          Number.isInteger(state.sidebarWindowId) &&
          tab &&
          tab.windowId === state.sidebarWindowId &&
          (tab.active || tabId === state.sourceTabId)
        ) {
          if (changeInfo.status === "loading") {
            beginSidebarTransition(tabId, tab);
          } else if (changeInfo.url) {
            beginSidebarTransition(tabId, tab);
            if (tab.active && tab.status !== "loading" && isNormalSidebarTab(tab)) {
              scheduleSidebarFollowScan(tabId);
            }
          } else if (changeInfo.status === "complete" && tab.active) {
            if (!isNormalSidebarTab(tab)) {
              beginSidebarTransition(tabId, tab);
            } else {
              scheduleSidebarFollowScan(tabId);
            }
          }
          return;
        }
        if (
          tabId === state.sourceTabId &&
          (changeInfo.url || changeInfo.status === "loading")
        ) {
          const nextUrl = String(changeInfo.url || tab && tab.url || "");
          const nextPageScopeKey = pageScopeKeyForUrl(nextUrl);
          if (changeInfo.url && canRetainSameInstagramRoute(
            state.pageScopeKey,
            nextPageScopeKey,
            changeInfo.status === "loading" || Boolean(tab && tab.status === "loading")
          )) {
            state.pageUrl = nextUrl;
            return;
          }
          sourcePageGeneration += 1;
          saveCurrentGallery();
          stopGalleryCollection();
          if (state.liveCapture) {
            stopLiveCapture();
          }
          if (state.siteKey && Core.siteKeyForUrl(nextUrl) === state.siteKey) {
            state.pageUrl = nextUrl;
            state.pageScopeKey = nextPageScopeKey;
            state.pageTitle = tab && tab.title || state.pageTitle;
            elements["page-label"].textContent = state.pageTitle;
            setNotice("Saved gallery kept while the next page loads.");
            renderImages();
          } else {
            resetSidebarPageState(
              tab && tab.title ? tab.title : "The source page changed",
              "The source page changed. Its gallery was saved for this website. Open AnyDownload on the loaded page if Firefox needs site access."
            );
          }
        }
        if (tabId === state.sourceTabId && (changeInfo.status === "complete" ||
          changeInfo.url && tab && tab.status === "complete")) {
          scheduleSourceRescan(sourcePageGeneration);
        }
      });
    }
    if (sidebarMode && browser.tabs && browser.tabs.onActivated) {
      browser.tabs.onActivated.addListener((activeInfo) => {
        handleSidebarTabActivated(activeInfo).catch((error) => {
          setNotice(`The sidebar could not follow the active tab. (${error.message || error})`, "error");
        });
      });
    }
  }

  function wireSidebarPermissionLifecycle() {
    if (!sidebarMode || !browser.permissions || typeof browser.permissions.contains !== "function") {
      return;
    }

    async function refreshPermissionState(showRemovalNotice) {
      const previouslyGranted = state.sidebarHasBroadAccess;
      try {
        state.sidebarHasBroadAccess = await browser.permissions.contains(SIDEBAR_ALL_URLS_PERMISSION);
      } catch (_error) {
        state.sidebarHasBroadAccess = false;
      }
      state.sidebarPermissionNeeded = !state.sidebarHasBroadAccess;
      updateSidebarFollowButton();
      if (showRemovalNotice && previouslyGranted && !state.sidebarHasBroadAccess) {
        setNotice(
          "Automatic sidebar updates are off because site access was removed. Enable auto-follow to turn them back on.",
          "error"
        );
      }
    }

    if (browser.permissions.onAdded) {
      browser.permissions.onAdded.addListener(() => {
        refreshPermissionState(false);
      });
    }
    if (browser.permissions.onRemoved) {
      browser.permissions.onRemoved.addListener(() => {
        refreshPermissionState(true);
      });
    }
  }

  function wireEvents() {
    elements["sort-select"].addEventListener("change", () => {
      state.sort = ["name", "resolution"].includes(elements["sort-select"].value) ? elements["sort-select"].value : "page";
      resetGalleryPage();
    });
    elements["selected-label"].addEventListener("click", () => {
      state.showSelected = !state.showSelected;
      state.showIgnored = false;
      resetGalleryPage();
    });
    elements["back-to-collection-button"].addEventListener("click", () => {
      state.showSelected = false;
      resetGalleryPage();
      elements["selected-label"].focus();
    });
    for (const [id, offset] of [["previous-page-button", -1], ["next-page-button", 1]]) {
      elements[id].addEventListener("click", () => {
        state.galleryPage += offset;
        elements["image-list"].scrollTop = 0;
        renderImages();
        if (elements[id].disabled) elements[offset > 0 ? "previous-page-button" : "next-page-button"].focus();
      });
    }
    elements["undo-clear-button"].addEventListener("click", undoClearSiteGallery);
    elements["close-preview-button"].addEventListener("click", () => elements["media-preview-dialog"].close());
    elements["preview-previous-button"].addEventListener("click", () => moveGalleryPreview(-1));
    elements["preview-next-button"].addEventListener("click", () => moveGalleryPreview(1));
    elements["preview-selected-input"].addEventListener("change", () => {
      selectImage(currentPreviewImage(), elements["preview-selected-input"].checked);
      renderImages();
    });
    elements["preview-download-button"].addEventListener("click", () => {
      const image = currentPreviewImage();
      if (image) {
        elements["media-preview-dialog"].close();
        requestDownloads([image], { allowRedownload: downloadStatusFor(image) === "downloaded" });
      }
    });
    elements["preview-tab-button"].addEventListener("click", () => {
      const image = currentPreviewImage();
      if (image) return openImagePreview(image);
    });
    elements["media-preview-dialog"].addEventListener("keydown", (event) => {
      if (event.target.closest("input, textarea, select, video")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        moveGalleryPreview(event.key === "ArrowLeft" ? -1 : 1);
      }
    });
    elements["media-preview-dialog"].addEventListener("close", () => {
      clearPreviewStage();
      previewItems = [];
      const opener = previewOpener;
      previewOpener = null;
      if (opener && opener.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
      else elements["filter-input"].focus({ preventScroll: true });
    });
    for (const view of ["grid", "list"]) {
      elements[`${view}-view-button`].addEventListener("click", () => {
        applyMediaView(view);
        persistSettings({ mediaLayout: view }).catch((error) => setNotice(error.message, "error"));
      });
    }
    elements["collect-gallery-button"].addEventListener("click", () => {
      collectGallery().catch((error) => setNotice(error.message || String(error), "error"));
    });
    elements["stop-gallery-button"].addEventListener("click", stopGalleryCollection);
    elements["refresh-media-button"].addEventListener("click", () => {
      return refreshMedia().catch((error) => setNotice(error.message || String(error), "error"));
    });
    elements["clear-gallery-button"].addEventListener("click", clearSiteGallery);
    globalThis.addEventListener("pagehide", () => {
      stopGalleryCollection();
      saveCurrentGallery();
    });
    for (const view of navigationWorkspaces) {
      const id = workspaces[view][0];
      elements[id].addEventListener("click", () => showWorkspace(view));
    }
    elements["tracker-panel"].addEventListener("toggle", () => {
      const open = elements["tracker-panel"].matches(":popover-open");
      elements["tracker-button"].setAttribute("aria-expanded", String(open));
      if (open) {
        elements["tracker-interval-select"].focus();
        refreshTrackerStatus(true).catch((error) => {
          elements["tracker-status"].textContent = error && error.message ? error.message : String(error);
          elements["tracker-status"].classList.add("error");
        });
      }
    });
    elements["tracker-save-button"].addEventListener("click", saveTracker);
    elements["tracker-action-select"].addEventListener("change", updateTrackerActionFields);
    elements["tracker-pagination-mode-select"].addEventListener("change", updateTrackerPaginationFields);
    elements["tracker-run-button"].addEventListener("click", runTrackerNow);
    elements["tracker-pause-button"].addEventListener("click", toggleTrackerEnabled);
    elements["tracker-delete-button"].addEventListener("click", deleteTracker);
    if (elements["sidebar-follow-button"]) {
      elements["sidebar-follow-button"].addEventListener("click", requestSidebarFollowPermission);
    }
    elements["instagram-collections-button"].addEventListener("click", collectInstagramCollections);
    elements["filter-input"].addEventListener("input", scheduleFilterRender);
    elements["folder-input"].addEventListener("input", updateSummary);
    elements["filename-template-button"].addEventListener("click", () => {
      const panel = elements["filename-template-panel"];
      panel.hidden = !panel.hidden;
      elements["filename-template-button"].setAttribute("aria-expanded", String(!panel.hidden));
    });
    elements["filename-template-input"].addEventListener("input", () => {
      refreshRenderedFilenamePreviews();
      updateSummary();
    });
    elements["filename-template-input"].addEventListener("change", async () => {
      const result = updateFilenameTemplateUi();
      if (result.ok) {
        elements["filename-template-input"].value = result.value;
        state.filenameTemplate = result.value;
        await persistSettings({ filenameTemplate: result.value }).catch((error) => setNotice(error.message, "error"));
      }
      refreshRenderedFilenamePreviews();
      updateSummary();
    });
    elements["folder-input"].addEventListener("change", async () => {
      const folder = folderStatus();
      if (folder.ok) {
        elements["folder-input"].value = folder.value;
        state.hasStoredFolder = true;
        await persistSettings({ destinationFolder: folder.value }).catch((error) => setNotice(error.message, "error"));
      }
      updateSummary();
    });
    elements["ask-single-input"].addEventListener("change", () => {
      persistSettings({ askForSingle: elements["ask-single-input"].checked }).catch((error) => setNotice(error.message, "error"));
    });
    elements["backgrounds-input"].addEventListener("change", () => {
      persistSettings({ includeBackgrounds: elements["backgrounds-input"].checked }).catch((error) => setNotice(error.message, "error"));
    });
    elements["photos-only-input"].addEventListener("change", handleSmartFilterChange);
    for (const id of [
      "media-type-filter-select",
      "format-filter-select", "min-width-input", "min-height-input", "orientation-filter-select"
    ]) {
      elements[id].addEventListener("change", handleSmartFilterChange);
    }
    elements["smart-filter-panel"].addEventListener("toggle", () => {
      const open = elements["smart-filter-panel"].matches(":popover-open");
      elements["smart-filters-button"].setAttribute("aria-expanded", String(open));
      updateSmartFilterButton();
    });
    elements["instagram-collection-filter-select"].addEventListener("change", () => {
      state.instagramCollectionFilter = elements["instagram-collection-filter-select"].value;
      state.showSelected = false;
      updateSmartFilterButton();
      resetGalleryPage();
    });
    elements["reset-filters-button"].addEventListener("click", resetMediaFilters);
    elements["ignored-button"].addEventListener("click", () => {
      state.showIgnored = !state.showIgnored;
      state.showSelected = false;
      resetGalleryPage();
      closeMediaFilters();
    });
    elements["downloaded-button"].addEventListener("click", () => {
      state.hideDownloaded = !state.hideDownloaded;
      state.showSelected = false;
      resetGalleryPage();
      closeMediaFilters();
    });
    elements["clear-ignored-button"].addEventListener("click", restoreAllIgnoredImages);
    elements["select-all-button"].addEventListener("click", () => {
      state.selected = new TrackedSelectionSet(filteredImages()
        .filter((image) => downloadStatusFor(image) !== "downloaded" && imageCanBeSelected(image))
        .map((image) => image.url));
      state.explicitRedownloads.clear();
      renderImages();
    });
    elements["select-none-button"].addEventListener("click", () => {
      if (hasCollectionFilter()) {
        for (const image of filteredImages()) {
          state.selected.delete(image.url);
          if (image.downloadFingerprint) {
            state.explicitRedownloads.delete(image.downloadFingerprint);
          }
        }
      } else {
        state.selected.clear();
        state.explicitRedownloads.clear();
      }
      renderImages();
    });
    elements["archive-footer-button"].addEventListener("click", downloadSelectedArchive);
    elements["upload-button"].addEventListener("click", uploadSelectedImages);
    elements["download-button"].addEventListener("click", downloadSelectedImages);
  }

  async function initializeSidebarContext() {
    if (!sidebarMode) {
      updateSidebarFollowButton();
      return;
    }
    try {
      const owningWindow = await browser.windows.getCurrent();
      if (owningWindow && Number.isInteger(owningWindow.id)) {
        state.sidebarWindowId = owningWindow.id;
      }
    } catch (_error) {
      // The active-tab fallback below can still identify the owning browser window.
    }
    if (!Number.isInteger(state.sidebarWindowId)) {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && Number.isInteger(tabs[0].windowId)) {
          state.sidebarWindowId = tabs[0].windowId;
        }
      } catch (_error) {
        // The regular scan will surface a friendly error if no window can be found.
      }
    }
    try {
      state.sidebarHasBroadAccess = await browser.permissions.contains(SIDEBAR_ALL_URLS_PERMISSION);
    } catch (_error) {
      state.sidebarHasBroadAccess = false;
    }
    state.sidebarPermissionNeeded = !state.sidebarHasBroadAccess;
    updateSidebarFollowButton();
  }

  async function initializeTrackerEditor() {
    if (browser.extension && browser.extension.inIncognitoContext) throw new Error("Trackers cannot be edited in private windows.");
    if (editTrackerId.length > 200) throw new Error("This tracker link is invalid.");
    const response = await browser.runtime.sendMessage({ type: "GET_TRACKERS" });
    const tracker = response && response.ok && Array.isArray(response.trackers) && response.trackers.find((item) => item.id === editTrackerId);
    if (!tracker || !Gallery.pageUrl(tracker.url)) throw new Error("This tracker no longer exists. Open Trackers to choose another one.");
    document.documentElement.classList.add("tracker-editor");
    state.incognito = false;
    state.tracker = tracker;
    state.pageUrl = tracker.url;
    state.siteKey = Core.siteKeyForUrl(tracker.url);
    state.pageTitle = tracker.pageTitle || hostFromUrl(tracker.url);
    state.trackerPageUrl = tracker.url;
    state.hasStoredFolder = true;
    elements["page-label"].textContent = `Edit tracker · ${state.pageTitle}`;
    elements["gallery-status"].textContent = tracker.url;
    elements["editor-source-link"].href = Gallery.pageUrl(tracker.url);
    elements["editor-source-link"].hidden = false;
    elements["folder-input"].value = tracker.folder;
    elements["filename-template-input"].value = tracker.filenameTemplate;
    applySmartFiltersToControls(tracker.filters);
    populateTrackerControls(tracker);
    updateTrackerUi();
    updateSmartFilterButton();
    elements["tracker-panel"].removeAttribute("popover");
    elements["tracker-button"].setAttribute("aria-expanded", "true");
    elements["action-detail"].textContent = `Downloads/${tracker.folder}`;
    updateFilenameTemplateUi();
    elements["tracker-interval-select"].focus();
  }

  async function initialize() {
    cacheElements();
    applySmartFiltersToControls(Filters.DEFAULT_FILTERS);
    elements["filename-template-input"].value = Templates.DEFAULT_TEMPLATE;
    updateFilenameTemplateUi();
    updateSidebarFollowButton();
    updateSmartFilterButton();
    updateInstagramCollectionFilterUi();
    updateTrackerUi();
    if (editTrackerId) {
      wireEvents();
      await initializeTrackerEditor();
      return;
    }
    await initializeSidebarContext();
    wireEvents();
    wireSourceTabLifecycle();
    wireSidebarPermissionLifecycle();
    browser.storage.onChanged.addListener(handleIgnoredStorageChanges);
    browser.storage.onChanged.addListener(handleTrackerStorageChanges);
    browser.storage.onChanged.addListener(handleDownloadStatusStorageChanges);
    browser.storage.onChanged.addListener(handleGalleryStorageChanges);
    browser.storage.onChanged.addListener(handleSettingsStorageChanges);
    try {
      const stored = await browser.storage.local.get([
        "destinationFolder",
        "askForSingle",
        "includeBackgrounds",
        "filenameTemplate",
        "smartFilters",
        "mediaLayout"
      ]);
      if (stored.destinationFolder) {
        elements["folder-input"].value = stored.destinationFolder;
        state.hasStoredFolder = true;
      }
      elements["ask-single-input"].checked = Boolean(stored.askForSingle);
      elements["backgrounds-input"].checked = stored.includeBackgrounds !== false;
      const storedTemplate = Templates.validate(stored.filenameTemplate);
      elements["filename-template-input"].value = storedTemplate.ok
        ? storedTemplate.value
        : Templates.DEFAULT_TEMPLATE;
      state.filenameTemplate = elements["filename-template-input"].value;
      updateFilenameTemplateUi();
      applySmartFiltersToControls(stored.smartFilters);
      applyMediaView(stored.mediaLayout);
      updateSmartFilterButton();
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
    if (sidebarMode) {
      refreshQueueBadge();
      startQueueBadgePolling();
      await scanCurrentSidebarTab();
      return;
    }
    const scanned = await scanPage();
    refreshQueueBadge();
    startQueueBadgePolling();
    if (scanned) {
      await startLiveCapture({ skipInitialScan: true, quiet: true });
      if (new URL(launchUrl).searchParams.get("collect") === "1") {
        await collectGallery();
      }
    }
  }

  function handleInitializationError(error) {
    console.error("AnyDownload popup initialization failed.", error);
    state.busy = false;
    const message = error && error.message ? error.message : String(error);
    const pageLabel = document.getElementById("page-label");
    const notice = document.getElementById("notice");
    if (pageLabel) {
      pageLabel.textContent = "AnyDownload could not start";
    }
    if (notice) {
      notice.textContent = `Reload the extension and try again. (${message})`;
      notice.className = "notice error";
      notice.hidden = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initialize().catch(handleInitializationError);
  }, { once: true });
  })();
})(globalThis);
