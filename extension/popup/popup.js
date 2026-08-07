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

  function mergeMediaRecord(existing, incoming) {
    if (!existing) {
      return incoming;
    }
    if (!incoming) {
      return existing;
    }
    return Object.assign({}, existing, incoming, {
      previewUrl: incoming.previewUrl || existing.previewUrl || "",
      alt: incoming.alt || existing.alt || "",
      width: Math.max(Number(existing.width) || 0, Number(incoming.width) || 0),
      height: Math.max(Number(existing.height) || 0, Number(incoming.height) || 0),
      duration: Math.max(Number(existing.duration) || 0, Number(incoming.duration) || 0),
      instagramCollections: mergeInstagramCollections(
        existing.instagramCollections,
        incoming.instagramCollections
      )
    });
  }

  function withoutInstagramCollectionTypes(images, excludedTypes) {
    const excluded = new Set(excludedTypes || []);
    const kept = [];
    for (const image of images || []) {
      const original = normalizedInstagramCollections(image && image.instagramCollections);
      if (!original.length) {
        kept.push(image);
        continue;
      }
      const remaining = original.filter((collection) => !excluded.has(collection.type));
      if (remaining.length) {
        kept.push(Object.assign({}, image, { instagramCollections: remaining }));
      }
    }
    return kept;
  }

  function accumulateLiveImages(previousImages, scannedImages, options) {
    const settings = Object.assign({ maxImages: 1500, maxPayloadLength: 2000000 }, options || {});
    const byUrl = new Map();
    for (const image of [...(previousImages || []), ...(scannedImages || [])]) {
      if (image && typeof image.url === "string" && image.url) {
        byUrl.set(image.url, mergeMediaRecord(byUrl.get(image.url), image));
      }
    }

    const images = [];
    let payloadLength = 0;
    for (const image of byUrl.values()) {
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
    return { images, trimmed: images.length < byUrl.size };
  }

  function reconcileScanSelection(nextImages, previousImages, previousSelected, preserve, isEligible) {
    const previousUrls = new Set((previousImages || []).map((image) => image && image.url));
    const selectedBefore = previousSelected instanceof Set
      ? previousSelected
      : new Set(previousSelected || []);
    const eligible = typeof isEligible === "function" ? isEligible : () => true;
    const selected = new Set();
    for (const image of nextImages || []) {
      if (!image || typeof image.url !== "string" || !eligible(image)) {
        continue;
      }
      if (!preserve || !previousUrls.has(image.url) || selectedBefore.has(image.url)) {
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
      mediaType: image && image.mediaType === "video" ? "video" : "image"
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
  const Instagram = globalThis.ImageDownloaderInstagram;
  const collectInstagramMediaFromPage = Instagram && Instagram.collectFromPage;
  const YouTube = globalThis.AnyDownloadYouTube;
  const collectYouTubeMediaFromPage = globalThis.AnyDownloadYouTubeCollector ||
    YouTube && YouTube.collectYouTubeMediaFromPage;
  const Filters = globalThis.ImageDownloaderFilters;
  const Templates = globalThis.ImageDownloaderTemplates;
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
  const SIDEBAR_ALL_URLS_PERMISSION = Object.freeze({ origins: ["<all_urls>"] });
  const launchUrl = globalScope.location && globalScope.location.href;
  const launchSourceTabId = sourceTabIdFromUrl(launchUrl);
  const launchOptions = launchOptionsFromUrl(launchUrl);
  const managerWindowMode = Number.isInteger(launchSourceTabId);
  const sidebarMode = launchOptions.sidebar;
  const responsiveSurface = managerWindowMode || sidebarMode;

  if (managerWindowMode) {
    document.documentElement.classList.add("manager-window");
  }
  if (sidebarMode) {
    document.documentElement.classList.add("sidebar-panel");
  }
  if (responsiveSurface) {
    document.documentElement.classList.add("responsive-surface");
  }

  const state = {
    images: [],
    selected: new Set(),
    scanWarnings: [],
    busy: false,
    hasStoredFolder: false,
    incognito: false,
    ignoredKeys: new Set(),
    filenameTemplate: Templates.DEFAULT_TEMPLATE,
    filenamePreviewByUrl: new Map(),
    instagramCollectionMode: false,
    instagramCollectionFilter: "all",
    liveCapture: false,
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
    sourceTabId: launchSourceTabId
  };

  const elements = {};
  const renderedMetaNodes = new Map();
  const renderedNameNodes = new Map();
  const visibleDimensionRows = new Map();
  let thumbnailObserver = null;
  let dimensionObserver = null;
  let ignoreWriteQueue = Promise.resolve();
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
      "archive-download-button",
      "archive-footer-button",
      "ask-single-input",
      "backgrounds-input",
      "bulk-download-button",
      "clear-ignored-button",
      "download-button",
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
      "ignored-button",
      "image-list",
      "instagram-collection-filter-field",
      "instagram-collection-filter-select",
      "instagram-collections-button",
      "media-type-filter-select",
      "notice",
      "open-window-button",
      "page-label",
      "photos-only-input",
      "queue-badge",
      "reset-filters-button",
      "select-all-button",
      "select-none-button",
      "selected-label",
      "sidebar-button",
      "sidebar-follow-button",
      "smart-filter-panel",
      "smart-filters-button",
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
      pageUrl: state.pageUrl,
      pageTitle: state.pageTitle,
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
    return renderFilenameBatch(images, (image, batchIndex, usedNames) => Templates.render(
      template.value,
      filenameMetadata(image, batchIndex, batchDate),
      { usedNames }
    ));
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
    return previews;
  }

  function updateFilenameTemplateUi() {
    const result = filenameTemplateStatus();
    const date = new Date();
    const previews = rebuildFilenamePreviews(result, date);
    const sample = selectedDownloadableImages()[0] ||
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
      ? "Tokens: {filename}, {name}, {ext}, {index}, {hostname}, {page-title}, {width}, {height}, {date}"
      : result.error;
    state.filenameTemplate = result.ok ? result.value : elements["filename-template-input"].value;
    return result;
  }

  function refreshRenderedFilenamePreviews() {
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
        record.checkbox.setAttribute("aria-label", `Select ${filename}`);
        record.previewButton.setAttribute("aria-label", `Preview ${filename} in a new tab`);
      }
      if (!records.size) {
        renderedNameNodes.delete(url);
      }
    }
  }

  async function openDownloadHistory() {
    const createProperties = {
      active: true,
      url: browser.runtime.getURL("history/history.html")
    };
    if (Number.isInteger(state.sourceWindowId)) {
      createProperties.windowId = state.sourceWindowId;
    }
    await browser.tabs.create(createProperties).catch((error) => {
      setNotice(`Firefox could not open the download queue. (${error.message || error})`, "error");
    });
  }

  async function refreshQueueBadge() {
    const generation = ++queueBadgeGeneration;
    try {
      const response = await browser.runtime.sendMessage({
        type: "GET_DOWNLOAD_DASHBOARD",
        incognito: state.incognito
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
    const nextValue = Boolean(value);
    if (state.incognito === nextValue) {
      return;
    }
    state.incognito = nextValue;
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
    state.images = [];
    state.selected.clear();
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
    if ((managerWindowMode || pinnedSource) && Number.isInteger(state.sourceTabId)) {
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

  function updateOpenWindowButton() {
    const button = elements["open-window-button"];
    if (!button) {
      return;
    }
    button.hidden = managerWindowMode;
    button.disabled = managerWindowMode || state.busy || !Number.isInteger(state.sourceTabId);
  }

  async function openManagerWindow() {
    if (managerWindowMode || !Number.isInteger(state.sourceTabId)) {
      setNotice("Wait for the current page scan before opening the large window.", "error");
      return;
    }

    const button = elements["open-window-button"];
    button.disabled = true;
    try {
      const result = await browser.runtime.sendMessage({
        type: "OPEN_MANAGER_WINDOW",
        sourceTabId: state.sourceTabId
      });
      if (!result || !result.ok) {
        throw new Error((result && result.error) || "Firefox could not open the large window.");
      }
      if (sidebarMode) {
        setNotice("Opened the resizable media window.", "success");
      } else {
        globalScope.close();
      }
    } catch (error) {
      setNotice(error && error.message ? error.message : String(error), "error");
      button.disabled = false;
    }
  }

  function openFirefoxSidebar() {
    const button = elements["sidebar-button"];
    if (!browser.sidebarAction || typeof browser.sidebarAction.open !== "function") {
      button.hidden = true;
      return;
    }

    try {
      const opening = browser.sidebarAction.open();
      Promise.resolve(opening).then(() => {
        globalScope.close();
      }).catch((error) => {
        setNotice(`Firefox could not open the sidebar: ${error.message || error}`, "error");
      });
    } catch (error) {
      setNotice(`Firefox could not open the sidebar: ${error.message || error}`, "error");
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

    if (changed) {
      if (!state.busy) {
        renderImages();
      }
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

  async function openImagePreview(image) {
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
          });
          continue;
        }
        for (const kind of image.kinds || []) {
          const safeKind = String(kind).slice(0, 50);
          if (current.kinds.length < 8 && !current.kinds.includes(safeKind)) {
            current.kinds.push(safeKind);
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
      images: Array.from(byUrl.values()),
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
      format: elements["format-filter-select"].value
    });
  }

  function applySmartFiltersToControls(filters) {
    const normalized = Filters.normalizeFilters(filters);
    state.smartFilters = normalized;
    elements["photos-only-input"].checked = normalized.photosOnly;
    elements["media-type-filter-select"].value = normalized.mediaType;
    elements["format-filter-select"].value = normalized.format;
  }

  function smartFilterCount(filters) {
    const normalized = Filters.normalizeFilters(filters);
    return Number(normalized.photosOnly) +
      Number(normalized.mediaType !== "any") +
      Number(normalized.format !== "any");
  }

  function updateSmartFilterButton() {
    const count = smartFilterCount(state.smartFilters) +
      Number(state.instagramCollectionFilter !== "all");
    const button = elements["smart-filters-button"];
    button.textContent = count ? `Filters (${count})` : "Filters";
    button.classList.toggle("active", count > 0 || !elements["smart-filter-panel"].hidden);
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
    browser.storage.local.set({ smartFilters: state.smartFilters }).catch(() => undefined);
  }

  function handleSmartFilterChange() {
    state.smartFilters = smartFiltersFromControls();
    for (const image of state.images) {
      if (
        isImageIgnored(image) ||
        !Filters.matchesSmartFilters(image, state.smartFilters) ||
        !matchesInstagramCollectionFilter(image, state.instagramCollectionFilter)
      ) {
        state.selected.delete(image.url);
      }
    }
    updateSmartFilterButton();
    persistSmartFilters();
    renderImages();
  }

  function scheduleSmartFilterRefresh() {
    if (!Filters.hasActiveSmartFilters(state.smartFilters) || smartFilterRefreshTimer !== null) {
      return;
    }
    smartFilterRefreshTimer = setTimeout(() => {
      smartFilterRefreshTimer = null;
      for (const image of state.images) {
        if (
          !Filters.matchesSmartFilters(image, state.smartFilters) ||
          !matchesInstagramCollectionFilter(image, state.instagramCollectionFilter)
        ) {
          state.selected.delete(image.url);
        }
      }
      renderImages();
    }, 50);
  }

  function filteredImages() {
    const query = elements["filter-input"].value.trim().toLocaleLowerCase();
    const inCurrentView = state.images.filter((image) =>
      isImageIgnored(image) === state.showIgnored &&
      imageMatchesSmartFilters(image) &&
      imageMatchesInstagramCollectionFilter(image)
    );
    if (!query) {
      return inCurrentView;
    }
    return inCurrentView.filter((image) => {
      const haystack = `${image.url} ${image.alt || ""} ${(image.kinds || []).join(" ")}`.toLocaleLowerCase();
      return haystack.includes(query);
    });
  }

  function selectedDownloadableImages() {
    return state.images.filter((image) =>
      state.selected.has(image.url) &&
      !isImageIgnored(image) &&
      Filters.matchesSmartFilters(image, state.smartFilters) &&
      imageMatchesInstagramCollectionFilter(image)
    );
  }

  function friendlyFilename(image) {
    const index = Math.max(0, state.images.indexOf(image));
    return state.filenamePreviewByUrl.get(image.url) || baseFilenameForMedia(image, index);
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

  function updateSummary() {
    const total = state.images.length;
    const ignoredCount = state.images.filter(isImageIgnored).length;
    const storedIgnoredCount = state.ignoredKeys.size;
    const availableCount = total - ignoredCount;
    const selectedItems = selectedDownloadableImages();
    const selected = selectedItems.length;
    const selectedHasVideo = selectedItems.some((item) => mediaTypeFor(item) === "video");
    const visible = filteredImages();
    const hasFilter = Boolean(elements["filter-input"].value.trim()) ||
      (!state.showIgnored && (
        Filters.hasActiveSmartFilters(state.smartFilters) ||
        state.instagramCollectionFilter !== "all"
      ));
    const folder = folderStatus();
    const template = filenameTemplateStatus();
    const viewTotal = state.showIgnored ? ignoredCount : availableCount;
    elements["summary-label"].textContent = hasFilter
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
    elements["select-all-button"].hidden = state.showIgnored;
    elements["select-none-button"].hidden = state.showIgnored;
    elements["select-all-button"].textContent = hasFilter ? "Select matches only" : "Select all";
    elements["select-none-button"].textContent = hasFilter ? "Clear matches" : "Clear";
    elements["download-button"].hidden = state.showIgnored;
    elements["archive-footer-button"].hidden = state.showIgnored;
    elements["bulk-download-button"].hidden = state.showIgnored || selected === 0;
    elements["bulk-download-button"].textContent = selected === 1
      ? "Download 1"
      : `Download ${selected.toLocaleString()}`;
    elements["bulk-download-button"].disabled = state.busy || selected === 0 || !folder.ok || !template.ok;
    elements["bulk-download-button"].title = folder.ok && template.ok
      ? "Download all selected files"
      : folder.error || template.error || "Enter valid download settings";
    elements["archive-download-button"].hidden = state.showIgnored || selected === 0;
    elements["archive-download-button"].textContent = selected === 1
      ? "ZIP 1"
      : `ZIP ${selected.toLocaleString()}`;
    elements["archive-download-button"].disabled = state.busy || selected === 0 ||
      selectedHasVideo || !folder.ok || !template.ok;
    elements["archive-download-button"].title = selectedHasVideo
      ? "ZIP archives currently support image-only selections"
      : folder.ok && template.ok
      ? "Download all selected images as ZIP archives"
      : folder.error || template.error || "Enter valid download settings";
    elements["selected-label"].textContent = state.showIgnored
      ? `${ignoredCount.toLocaleString()} ignored here`
      : `${selected.toLocaleString()} selected`;
    elements["action-detail"].textContent = state.showIgnored
      ? storedIgnoredCount === ignoredCount
        ? "Restore media to make it downloadable again"
        : `${storedIgnoredCount.toLocaleString()} rules saved for this site`
      : selected
        ? template.ok
          ? `Ready for Downloads/${folder.ok ? folder.value : "…"}`
          : template.error
        : "Choose files to download";
    elements["download-button"].textContent = selected === 1
      ? `Download ${mediaTypeFor(selectedItems[0])}`
      : "Download selected";
    elements["download-button"].disabled = state.busy || selected === 0 || !folder.ok || !template.ok;
    elements["archive-footer-button"].disabled = state.busy || selected === 0 ||
      selectedHasVideo || !folder.ok || !template.ok;
    elements["archive-footer-button"].title = selectedHasVideo
      ? "ZIP archives currently support image-only selections"
      : "Download selected images as ZIP archives";
    updateInstagramCollectionsButton();
    elements["image-list"].setAttribute(
      "aria-label",
      state.showIgnored ? "Ignored media found on this page" : "Media found on this page"
    );
  }

  function makeImageRow(image) {
    const ignored = isImageIgnored(image);
    const video = mediaTypeFor(image) === "video";
    const row = document.createElement("article");
    row.className = `image-row${video ? " video" : ""}${ignored ? " ignored" : ""}`;
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
      refreshRenderedFilenamePreviews();
      updateSummary();
    });

    const thumbnailFrame = document.createElement("button");
    thumbnailFrame.type = "button";
    thumbnailFrame.className = `thumbnail-frame${video ? " video" : ""}`;
    thumbnailFrame.title = `Open ${video ? "video" : "image"} preview in a new tab`;
    thumbnailFrame.setAttribute("aria-label", `Preview ${friendlyFilename(image)} in a new tab`);
    thumbnailFrame.disabled = state.busy;
    thumbnailFrame.addEventListener("click", () => openImagePreview(image));
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
    let nameRecords = renderedNameNodes.get(image.url);
    if (!nameRecords) {
      nameRecords = new Set();
      renderedNameNodes.set(image.url, nameRecords);
    }
    nameRecords.add({
      label: filenameLabel,
      container: name,
      checkbox,
      previewButton: thumbnailFrame
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
      download.textContent = "Save";
      download.title = `Download only this ${video ? "video" : "image"}`;
      download.disabled = state.busy;
      download.addEventListener("click", () => requestDownloads([image]));
      actions.append(ignore, download);
      row.append(checkbox, thumbnailFrame, copy, actions);
    }
    return row;
  }

  function renderImages() {
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
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const ignoredCount = state.images.filter(isImageIgnored).length;
      if (state.showIgnored) {
        empty.textContent = ignoredCount
          ? "No ignored media match this filter."
          : state.ignoredKeys.size
            ? `No ignored media are present on this page. Use Restore all to clear the ${state.ignoredKeys.size.toLocaleString()} stored site rule${state.ignoredKeys.size === 1 ? "" : "s"}.`
            : "No ignored media are present on this page.";
      } else if (state.images.length && ignoredCount === state.images.length) {
        empty.textContent = `All ${ignoredCount.toLocaleString()} media items on this page are ignored. Open the Ignored view to restore any of them.`;
      } else {
        empty.textContent = state.images.length
          ? "No media match this filter."
          : "No downloadable images or direct video files were found in the loaded page.";
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

    const previousImages = state.images;
    const previousByUrl = new Map(previousImages.map((image) => [image.url, image]));
    const previousSelected = new Set(state.selected);
    const previousPageScopeKey = state.pageScopeKey;
    const previousIgnoredKeys = new Set(state.ignoredKeys);
    const previousInstagramCollectionMode = state.instagramCollectionMode;
    let scanTab = null;
    let succeeded = false;
    state.busy = true;
    updateOpenWindowButton();
    if (!settings.preserveSelection) {
      state.images = [];
      state.selected.clear();
      state.showIgnored = false;
      state.siteKey = "";
      state.ignoredKeys.clear();
      state.pageTitle = "";
      state.pageUrl = "";
      state.pageScopeKey = "";
      state.instagramCollectionFilter = "all";
      state.instagramCollectionMode = false;
      updateInstagramCollectionFilterUi();
      updateFilenameTemplateUi();
      elements["image-list"].replaceChildren();
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
      let youtubeWarning = "";
      let youtubeCollectionSucceeded = false;
      const instagramPage = Boolean(
        Instagram &&
        typeof Instagram.isInstagramUrl === "function" &&
        typeof collectInstagramMediaFromPage === "function" &&
        Instagram.isInstagramUrl(tab.url)
      );

      if (instagramPage) {
        if (settings.instagramCollections) {
          elements["page-label"].textContent = "Collecting Instagram stories and highlights…";
        }
        try {
          const instagramResults = await browser.scripting.executeScript({
            target: { tabId: tab.id },
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

      const youtubePage = Boolean(
        !instagramPage &&
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
        state.siteKey = "";
        state.pageScopeKey = "";
        state.ignoredKeys.clear();
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
      if (youtubeWarning) {
        merged.warnings.push(youtubeWarning);
      }

      const nextSiteKey = Core.siteKeyForUrl(merged.page.pageUrl);
      const nextPageScopeKey = pageScopeKeyForUrl(merged.page.pageUrl);
      const preserveThisPage = settings.preserveSelection &&
        nextPageScopeKey === previousPageScopeKey;
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
        state.siteKey = "";
        state.pageScopeKey = "";
        state.ignoredKeys.clear();
        return false;
      }

      if (preserveThisPage) {
        for (const image of merged.images) {
          const previous = previousByUrl.get(image.url);
          if (!previous) {
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

      if (settings.instagramCollections && preserveThisPage) {
        const retained = withoutInstagramCollectionTypes(previousImages, ["story", "highlight"]);
        const accumulated = accumulateLiveImages(retained, merged.images, {
          maxImages: MAX_DISCOVERED_IMAGES,
          maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH
        });
        if (accumulated.trimmed) {
          merged.warnings.push("Instagram collection results reached the 1,500-item or 2 MB safety limit.");
        }
        merged.images = accumulated.images;
      } else if (settings.live && preserveThisPage) {
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
      state.selected = reconcileScanSelection(
        merged.images,
        previousImages,
        previousSelected,
        preserveThisPage,
        (image) => !isImageIgnored(image) &&
          Filters.matchesSmartFilters(image, state.smartFilters) &&
          matchesInstagramCollectionFilter(image, state.instagramCollectionFilter)
      );
      state.scanWarnings = merged.warnings;
      state.pageTitle = merged.page.pageTitle || "";
      state.pageUrl = merged.page.pageUrl || "";
      state.instagramCollectionMode = Boolean(
        instagramCollectionSucceeded ||
        (settings.live && preserveThisPage && previousInstagramCollectionMode) ||
        (settings.instagramCollections && preservedInstagramFallback && previousInstagramCollectionMode)
      );
      updateInstagramCollectionFilterUi();
      const hostname = hostFromUrl(merged.page.pageUrl);
      elements["page-label"].textContent = merged.page.pageTitle || hostname;
      updateFilenameTemplateUi();

      if (!state.hasStoredFolder) {
        const safeHost = Core.sanitizePathSegment(hostname, "page");
        elements["folder-input"].value = `${Core.DEFAULT_FOLDER}/${safeHost}`;
      }

      const addedCount = preserveThisPage
        ? merged.images.filter((image) => !previousByUrl.has(image.url)).length
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
      if (!settings.preserveSelection) {
        state.images = [];
        state.selected.clear();
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
      state.busy = false;
      updateOpenWindowButton();
      renderImages();
    }
    return succeeded;
  }

  async function requestDownloads(images) {
    images = images.filter((image) =>
      !isImageIgnored(image) &&
      Filters.matchesSmartFilters(image, state.smartFilters) &&
      matchesInstagramCollectionFilter(image, state.instagramCollectionFilter)
    );
    if (state.busy || !images.length) {
      if (!state.busy) {
        setNotice("No downloadable media files are selected.", "error");
      }
      return;
    }
    const folder = folderStatus();
    if (!folder.ok) {
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
      await browser.storage.local.set(storedSettings);
      await loadIgnoredKeys();
      for (const image of state.images) {
        if (isImageIgnored(image)) {
          state.selected.delete(image.url);
        }
      }
      images = images.filter((image) =>
        !isImageIgnored(image) &&
        Filters.matchesSmartFilters(image, state.smartFilters) &&
        imageMatchesInstagramCollectionFilter(image)
      );
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
      await browser.storage.local.set(storedSettings);
      await loadIgnoredKeys();
      for (const image of state.images) {
        if (isImageIgnored(image)) {
          state.selected.delete(image.url);
        }
      }
      images = images.filter((image) =>
        mediaTypeFor(image) === "image" &&
        !isImageIgnored(image) &&
        Filters.matchesSmartFilters(image, state.smartFilters) &&
        imageMatchesInstagramCollectionFilter(image)
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

  function wireSourceTabLifecycle() {
    if (browser.tabs && browser.tabs.onRemoved) {
      browser.tabs.onRemoved.addListener((tabId) => {
        if (tabId !== state.sourceTabId) {
          return;
        }
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
          if (state.liveCapture) {
            stopLiveCapture();
          }
          resetSidebarPageState(
            tab && tab.title ? tab.title : "The source page changed",
            "The source page changed, so its previous media was cleared. Open AnyDownload on the loaded page to continue.",
            "error"
          );
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
    elements["open-window-button"].addEventListener("click", openManagerWindow);
    elements["sidebar-button"].addEventListener("click", openFirefoxSidebar);
    elements["history-button"].addEventListener("click", openDownloadHistory);
    if (elements["sidebar-follow-button"]) {
      elements["sidebar-follow-button"].addEventListener("click", requestSidebarFollowPermission);
    }
    elements["instagram-collections-button"].addEventListener("click", collectInstagramCollections);
    elements["filter-input"].addEventListener("input", renderImages);
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
        await browser.storage.local.set({ filenameTemplate: result.value });
      }
      refreshRenderedFilenamePreviews();
      updateSummary();
    });
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
    elements["photos-only-input"].addEventListener("change", handleSmartFilterChange);
    for (const id of [
      "media-type-filter-select",
      "format-filter-select"
    ]) {
      elements[id].addEventListener("change", handleSmartFilterChange);
    }
    elements["smart-filters-button"].addEventListener("click", () => {
      const panel = elements["smart-filter-panel"];
      panel.hidden = !panel.hidden;
      elements["smart-filters-button"].setAttribute("aria-expanded", String(!panel.hidden));
      updateSmartFilterButton();
    });
    elements["instagram-collection-filter-select"].addEventListener("change", () => {
      state.instagramCollectionFilter = elements["instagram-collection-filter-select"].value;
      for (const image of state.images) {
        if (!matchesInstagramCollectionFilter(image, state.instagramCollectionFilter)) {
          state.selected.delete(image.url);
        }
      }
      updateSmartFilterButton();
      renderImages();
    });
    elements["reset-filters-button"].addEventListener("click", () => {
      state.instagramCollectionFilter = "all";
      elements["instagram-collection-filter-select"].value = "all";
      applySmartFiltersToControls(Filters.DEFAULT_FILTERS);
      handleSmartFilterChange();
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
      if (
        elements["filter-input"].value.trim() ||
        Filters.hasActiveSmartFilters(state.smartFilters) ||
        state.instagramCollectionFilter !== "all"
      ) {
        for (const image of filteredImages()) {
          state.selected.delete(image.url);
        }
      } else {
        state.selected.clear();
      }
      renderImages();
    });
    elements["bulk-download-button"].addEventListener("click", downloadSelectedImages);
    elements["archive-download-button"].addEventListener("click", downloadSelectedArchive);
    elements["archive-footer-button"].addEventListener("click", downloadSelectedArchive);
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

  async function initialize() {
    cacheElements();
    applySmartFiltersToControls(Filters.DEFAULT_FILTERS);
    elements["filename-template-input"].value = Templates.DEFAULT_TEMPLATE;
    updateFilenameTemplateUi();
    elements["sidebar-button"].hidden = responsiveSurface ||
      !browser.sidebarAction ||
      typeof browser.sidebarAction.open !== "function";
    updateSidebarFollowButton();
    updateOpenWindowButton();
    updateSmartFilterButton();
    updateInstagramCollectionFilterUi();
    await initializeSidebarContext();
    wireEvents();
    wireSourceTabLifecycle();
    wireSidebarPermissionLifecycle();
    browser.storage.onChanged.addListener(handleIgnoredStorageChanges);
    try {
      const stored = await browser.storage.local.get([
        "destinationFolder",
        "askForSingle",
        "includeBackgrounds",
        "filenameTemplate",
        "smartFilters"
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
      updateSmartFilterButton();
    } catch (_error) {
      // Defaults are sufficient if storage is unavailable.
    }
    try {
      const platform = await browser.runtime.getPlatformInfo();
      if (platform.os === "android") {
        elements["sidebar-button"].hidden = true;
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
