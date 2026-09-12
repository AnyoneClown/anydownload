(function attachAnyDownloadTracker(root, factory) {
  "use strict";

  const api = factory(
    root && root.ImageDownloaderCore,
    root && root.ImageDownloaderFilters
  );
  if (typeof module === "object" && module && module.exports) {
    module.exports = factory(
      require("./core.js"),
      require("./filters.js")
    );
    return;
  }
  root.AnyDownloadTracker = api;
})(typeof globalThis === "object" ? globalThis : this, function createAnyDownloadTracker(Core, Filters) {
  "use strict";

  const STORAGE_KEY = "mediaTrackers:v1";
  const REVIEW_STORAGE_KEY = "trackerReviewItems:v1";
  const ALARM_PREFIX = "mediaTracker:";
  const MAX_TRACKERS = 20;
  const MAX_SEEN = 5000;
  const MAX_ITEMS_PER_SCAN = 500;
  const MAX_DOWNLOADS_PER_RUN = 100;
  const MAX_ACTIVITY = 40;
  const MAX_REVIEW_ITEMS = 500;
  const MAX_REVIEW_PAYLOAD_LENGTH = 2 * 1024 * 1024;
  const MAX_PATTERNS = 20;
  const MAX_PAGES_PER_RUN = 10;
  const MIN_INTERVAL_MINUTES = 15;
  const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
  const MAX_HTML_BYTES = 4 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 15000;
  const MEDIA_EXTENSION = /\.(?:apng|avif|bmp|gif|ico|jpe?g|jxl|m4v|mkv|mov|mp4|ogg|ogv|png|svg|tiff?|webm|webp)(?:$|[?#])/i;
  const VIDEO_EXTENSION = /\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)(?:$|[?#])/i;
  const VOLATILE_QUERY_PARAM = /^(?:x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders)|x-goog-(?:algorithm|credential|date|expires|signature|signedheaders)|expires?|expiry|exp|signature|sig|policy|key-pair-id|auth(?:entication)?|access[_-]?token|session[_-]?token|token|utm_[a-z0-9_]+|fbclid|gclid|dclid|_?cb|cache(?:buster)?|timestamp)$/i;

  function safeProperty(object, key) {
    try {
      return object && typeof object === "object" ? object[key] : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  function safeText(value, maximum) {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum || 500);
  }

  function finiteInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(number)));
  }

  function normalizePageUrl(value) {
    try {
      const parsed = new URL(safeText(value, 16384));
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      ) {
        return "";
      }
      parsed.hash = "";
      return parsed.href.slice(0, 16384);
    } catch (_error) {
      return "";
    }
  }

  function permissionPatternForUrl(value) {
    try {
      const parsed = new URL(normalizePageUrl(value));
      return `${parsed.protocol}//${parsed.hostname}/*`;
    } catch (_error) {
      return "";
    }
  }

  function trackerId(value) {
    const id = safeText(value, 100);
    return /^[a-z0-9-]{8,100}$/i.test(id) ? id : "";
  }

  function boundedTime(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number))
      : 0;
  }

  function normalizeSeen(value) {
    const seen = [];
    const unique = new Set();
    for (const raw of Array.isArray(value) ? value : []) {
      const fingerprint = safeText(raw, 40).toLowerCase();
      if (!/^[a-f0-9]{16}$/.test(fingerprint) || unique.has(fingerprint)) {
        continue;
      }
      unique.add(fingerprint);
      seen.push(fingerprint);
      if (seen.length >= MAX_SEEN) {
        break;
      }
    }
    return seen;
  }

  function normalizePatterns(value) {
    const rawValues = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[\n,]+/)
        : [];
    const patterns = [];
    const unique = new Set();
    for (const raw of rawValues) {
      const pattern = safeText(raw, 240);
      const key = pattern.toLocaleLowerCase();
      if (!pattern || unique.has(key)) {
        continue;
      }
      unique.add(key);
      patterns.push(pattern);
      if (patterns.length >= MAX_PATTERNS) {
        break;
      }
    }
    return patterns;
  }

  function normalizeMatching(value, fallbackQuery) {
    return {
      includeText: safeText(safeProperty(value, "includeText"), 200) || safeText(fallbackQuery, 200),
      excludeText: safeText(safeProperty(value, "excludeText"), 200),
      includePatterns: normalizePatterns(safeProperty(value, "includePatterns")),
      excludePatterns: normalizePatterns(safeProperty(value, "excludePatterns")),
      maxDownloadsPerRun: finiteInteger(
        safeProperty(value, "maxDownloadsPerRun"),
        MAX_DOWNLOADS_PER_RUN,
        1,
        MAX_DOWNLOADS_PER_RUN
      )
    };
  }

  function normalizeNotifications(value) {
    return {
      newMatches: safeProperty(value, "newMatches") !== false,
      errors: safeProperty(value, "errors") !== false
    };
  }

  function normalizeAction(value) {
    const action = safeText(value, 20).toLowerCase();
    return ["download", "review", "notify"].includes(action) ? action : "download";
  }

  function normalizePagination(value, baseUrl) {
    const requestedMode = safeText(safeProperty(value, "mode"), 30).toLowerCase();
    let mode = ["next-link", "url-template"].includes(requestedMode) ? requestedMode : "none";
    const urlTemplate = safeText(safeProperty(value, "urlTemplate"), 16384);
    if (mode === "url-template") {
      try {
        if (!urlTemplate.includes("{page}")) {
          mode = "none";
        } else {
          const candidate = new URL(urlTemplate.split("{page}").join("2"), baseUrl);
          const base = new URL(baseUrl);
          if (
            candidate.origin !== base.origin ||
            !["http:", "https:"].includes(candidate.protocol) ||
            candidate.username ||
            candidate.password
          ) {
            mode = "none";
          }
        }
      } catch (_error) {
        mode = "none";
      }
    }
    return {
      mode,
      maxPages: mode === "none"
        ? 1
        : finiteInteger(safeProperty(value, "maxPages"), 3, 2, MAX_PAGES_PER_RUN),
      nextSelector: safeText(safeProperty(value, "nextSelector"), 240),
      urlTemplate: mode === "url-template" ? urlTemplate : ""
    };
  }

  function normalizeActivity(value) {
    const records = [];
    for (const raw of Array.isArray(value) ? value.slice(-MAX_ACTIVITY) : []) {
      const startedAt = boundedTime(safeProperty(raw, "startedAt"));
      if (!startedAt) {
        continue;
      }
      const statusValue = safeText(safeProperty(raw, "status"), 20).toLowerCase();
      records.push({
        startedAt,
        finishedAt: boundedTime(safeProperty(raw, "finishedAt")) || startedAt,
        durationMs: finiteInteger(safeProperty(raw, "durationMs"), 0, 0, 24 * 60 * 60 * 1000),
        reason: ["alarm", "manual", "save", "permission"].includes(safeProperty(raw, "reason"))
          ? safeProperty(raw, "reason")
          : "alarm",
        status: ["baseline", "success", "partial", "error", "skipped"].includes(statusValue)
          ? statusValue
          : "error",
        pagesChecked: finiteInteger(safeProperty(raw, "pagesChecked"), 0, 0, MAX_PAGES_PER_RUN),
        found: finiteInteger(safeProperty(raw, "found"), 0, 0, MAX_ITEMS_PER_SCAN),
        discovered: finiteInteger(safeProperty(raw, "discovered"), 0, 0, MAX_DOWNLOADS_PER_RUN),
        reviewed: finiteInteger(safeProperty(raw, "reviewed"), 0, 0, MAX_DOWNLOADS_PER_RUN),
        queued: finiteInteger(safeProperty(raw, "queued"), 0, 0, MAX_DOWNLOADS_PER_RUN),
        message: safeText(safeProperty(raw, "message"), 500)
      });
    }
    return records;
  }

  function appendActivity(existing, record) {
    return normalizeActivity([...normalizeActivity(existing), record]).slice(-MAX_ACTIVITY);
  }

  function normalizeTracker(value, nowValue) {
    const now = boundedTime(nowValue) || Date.now();
    const id = trackerId(safeProperty(value, "id"));
    const url = normalizePageUrl(safeProperty(value, "url"));
    const folderResult = Core && typeof Core.validateFolderPath === "function"
      ? Core.validateFolderPath(safeProperty(value, "folder"))
      : { ok: false };
    const templateResult = safeText(safeProperty(value, "filenameTemplate"), 240);
    if (!id || !url || !folderResult.ok || !templateResult) {
      return null;
    }
    const matching = normalizeMatching(safeProperty(value, "matching"), safeProperty(value, "query"));
    const action = normalizeAction(safeProperty(value, "action"));
    const notifications = normalizeNotifications(safeProperty(value, "notifications"));
    if (action === "notify") {
      notifications.newMatches = true;
    }
    return {
      id,
      url,
      pageTitle: safeText(safeProperty(value, "pageTitle"), 300) || url,
      folder: folderResult.value,
      intervalMinutes: finiteInteger(
        safeProperty(value, "intervalMinutes"),
        60,
        MIN_INTERVAL_MINUTES,
        MAX_INTERVAL_MINUTES
      ),
      filters: Filters && typeof Filters.normalizeFilters === "function"
        ? Filters.normalizeFilters(safeProperty(value, "filters"))
        : { mediaType: "any", photosOnly: false, format: "any", minWidth: 0, minHeight: 0, orientation: "any" },
      query: matching.includeText,
      matching,
      pagination: normalizePagination(safeProperty(value, "pagination"), url),
      action,
      notifications,
      filenameTemplate: templateResult,
      downloadInitial: safeProperty(value, "downloadInitial") === true,
      enabled: safeProperty(value, "enabled") !== false,
      initialized: safeProperty(value, "initialized") === true,
      seen: normalizeSeen(safeProperty(value, "seen")),
      createdAt: boundedTime(safeProperty(value, "createdAt")) || now,
      updatedAt: boundedTime(safeProperty(value, "updatedAt")) || now,
      lastRunAt: boundedTime(safeProperty(value, "lastRunAt")),
      lastSuccessAt: boundedTime(safeProperty(value, "lastSuccessAt")),
      nextRunAt: boundedTime(safeProperty(value, "nextRunAt")),
      backoffUntil: boundedTime(safeProperty(value, "backoffUntil")),
      consecutiveErrors: finiteInteger(safeProperty(value, "consecutiveErrors"), 0, 0, 100),
      consecutiveAuthorizationErrors: finiteInteger(
        safeProperty(value, "consecutiveAuthorizationErrors"),
        0,
        0,
        100
      ),
      autoPausedReason: safeText(safeProperty(value, "autoPausedReason"), 500),
      lastFound: finiteInteger(safeProperty(value, "lastFound"), 0, 0, MAX_ITEMS_PER_SCAN),
      lastDiscovered: finiteInteger(safeProperty(value, "lastDiscovered"), 0, 0, MAX_DOWNLOADS_PER_RUN),
      lastReviewed: finiteInteger(safeProperty(value, "lastReviewed"), 0, 0, MAX_DOWNLOADS_PER_RUN),
      lastQueued: finiteInteger(safeProperty(value, "lastQueued"), 0, 0, MAX_DOWNLOADS_PER_RUN),
      lastPagesChecked: finiteInteger(safeProperty(value, "lastPagesChecked"), 0, 0, MAX_PAGES_PER_RUN),
      lastDurationMs: finiteInteger(safeProperty(value, "lastDurationMs"), 0, 0, 24 * 60 * 60 * 1000),
      lastError: safeText(safeProperty(value, "lastError"), 500),
      activity: normalizeActivity(safeProperty(value, "activity"))
    };
  }

  function normalizeTrackers(value, now) {
    const trackers = [];
    const ids = new Set();
    const urls = new Set();
    for (const raw of Array.isArray(value) ? value : []) {
      const tracker = normalizeTracker(raw, now);
      if (!tracker || ids.has(tracker.id) || urls.has(tracker.url)) {
        continue;
      }
      ids.add(tracker.id);
      urls.add(tracker.url);
      trackers.push(tracker);
      if (trackers.length >= MAX_TRACKERS) {
        break;
      }
    }
    return trackers;
  }

  function stableMediaValue(item) {
    const explicit = safeText(safeProperty(item, "identityKey"), 300);
    if (explicit) {
      return `identity:${explicit}`;
    }
    const url = normalizePageUrl(safeProperty(item, "url"));
    if (!url) {
      return "";
    }
    try {
      const parsed = new URL(url);
      const stable = [];
      for (const [name, value] of parsed.searchParams) {
        if (!VOLATILE_QUERY_PARAM.test(name)) {
          stable.push([name, value]);
        }
      }
      stable.sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
      );
      parsed.search = "";
      for (const [name, value] of stable) {
        parsed.searchParams.append(name, value);
      }
      return `url:${parsed.href}`;
    } catch (_error) {
      return `url:${url}`;
    }
  }

  function shortHash(value) {
    let first = 2166136261;
    let second = 2654435761;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second ^= code + index;
      second = Math.imul(second, 2246822519);
    }
    return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
  }

  function mediaFingerprint(item) {
    const stable = stableMediaValue(item);
    return stable ? shortHash(stable) : "";
  }

  function recordSeen(existing, additions) {
    const ordered = [];
    const unique = new Set();
    for (const raw of [...normalizeSeen(additions), ...normalizeSeen(existing)]) {
      if (unique.has(raw)) {
        continue;
      }
      unique.add(raw);
      ordered.push(raw);
      if (ordered.length >= MAX_SEEN) {
        break;
      }
    }
    return ordered;
  }

  function matchesQuery(item, query) {
    const needle = safeText(query, 200).toLocaleLowerCase();
    if (!needle) {
      return true;
    }
    const haystack = ["url", "alt", "title", "filename", "name"]
      .map((key) => safeText(safeProperty(item, key), 2048))
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(needle);
  }

  function wildcardMatches(value, pattern) {
    const source = safeText(pattern, 240);
    if (!source) {
      return false;
    }
    const expression = source
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .split("*").join(".*")
      .split("?").join(".");
    try {
      return new RegExp(`^${expression}$`, "i").test(String(value || "").slice(0, 16384));
    } catch (_error) {
      return false;
    }
  }

  function matchesTrackerRules(item, value) {
    const rules = normalizeMatching(value, "");
    if (rules.includeText && !matchesQuery(item, rules.includeText)) {
      return false;
    }
    if (rules.excludeText && matchesQuery(item, rules.excludeText)) {
      return false;
    }
    const url = normalizePageUrl(safeProperty(item, "url"));
    if (rules.includePatterns.length && !rules.includePatterns.some((pattern) => wildcardMatches(url, pattern))) {
      return false;
    }
    if (rules.excludePatterns.some((pattern) => wildcardMatches(url, pattern))) {
      return false;
    }
    return true;
  }

  function pageUrlFromTemplate(template, pageNumber, baseUrl) {
    try {
      if (!String(template || "").includes("{page}")) {
        return "";
      }
      const base = new URL(normalizePageUrl(baseUrl));
      const parsed = new URL(
        String(template).split("{page}").join(String(finiteInteger(pageNumber, 2, 2, MAX_PAGES_PER_RUN + 1))),
        base
      );
      if (
        parsed.origin !== base.origin ||
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      ) {
        return "";
      }
      parsed.hash = "";
      return parsed.href;
    } catch (_error) {
      return "";
    }
  }

  function extractNextPageUrl(documentObject, pageUrl, selector) {
    const selectors = selector
      ? [safeText(selector, 240)]
      : [
        "a[rel~='next']",
        "link[rel~='next']",
        "a.next",
        ".pagination a.next",
        ".pager a.next",
        "a[aria-label*='next' i]"
      ];
    let node = null;
    for (const candidate of selectors) {
      if (!candidate) {
        continue;
      }
      try {
        node = documentObject.querySelector(candidate);
      } catch (_error) {
        return "";
      }
      if (node) {
        break;
      }
    }
    if (!node) {
      return "";
    }
    const raw = getAttribute(node, "href") || getAttribute(node, "data-href");
    try {
      const current = new URL(normalizePageUrl(pageUrl));
      const baseHref = getAttribute(documentObject.querySelector("base[href]"), "href");
      const next = new URL(raw, baseHref ? new URL(baseHref, current) : current);
      if (
        next.origin !== current.origin ||
        !["http:", "https:"].includes(next.protocol) ||
        next.username ||
        next.password
      ) {
        return "";
      }
      next.hash = "";
      return next.href;
    } catch (_error) {
      return "";
    }
  }

  function getAttribute(element, name) {
    try {
      return safeText(element && element.getAttribute && element.getAttribute(name), 16384);
    } catch (_error) {
      return "";
    }
  }

  function candidateFromSrcset(value) {
    const entries = safeText(value, 65536).split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const descriptor = parts[1] || "";
      const score = descriptor.endsWith("w")
        ? Number(descriptor.slice(0, -1)) || 0
        : descriptor.endsWith("x")
          ? (Number(descriptor.slice(0, -1)) || 0) * 10000
          : 0;
      return { url: parts[0] || "", score };
    }).filter((entry) => entry.url);
    entries.sort((left, right) => right.score - left.score);
    return entries[0] && entries[0].url || "";
  }

  function extractMediaFromDocument(documentObject, pageUrl, options) {
    const settings = options && typeof options === "object" ? options : {};
    const maxItems = finiteInteger(settings.maxItems, MAX_ITEMS_PER_SCAN, 1, MAX_ITEMS_PER_SCAN);
    const maxPayloadLength = finiteInteger(settings.maxPayloadLength, 1000000, 1024, 2000000);
    const found = new Map();
    let payloadLength = 0;
    let nodes = [];
    try {
      nodes = Array.from(documentObject.querySelectorAll([
        "img", "picture source", "svg image", "video", "video source", "input[type='image']",
        "a[href]", "[data-src]", "[data-srcset]", "[data-lazy-src]", "[data-original]",
        "[data-original-src]", "[data-full]", "[data-full-src]", "[style*='url']"
      ].join(",")));
    } catch (_error) {
      nodes = [];
    }

    function add(rawUrl, node, declaredType) {
      if (found.size >= maxItems) {
        return false;
      }
      let normalized = "";
      try {
        const parsed = new URL(safeText(rawUrl, 16384), pageUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return false;
        }
        parsed.hash = "";
        normalized = parsed.href.slice(0, 16384);
      } catch (_error) {
        return false;
      }
      const tag = safeText(node && (node.localName || node.tagName), 20).toLowerCase();
      const type = safeText(declaredType || getAttribute(node, "type"), 100).toLowerCase();
      const elementImpliesMedia = ["image", "img", "video", "source", "input"].includes(tag) ||
        type.startsWith("image/") || type.startsWith("video/");
      if (!elementImpliesMedia && !MEDIA_EXTENSION.test(normalized)) {
        return false;
      }
      const mediaType = tag === "video" || type.startsWith("video/") || VIDEO_EXTENSION.test(normalized)
        ? "video"
        : "image";
      let previewUrl = mediaType === "image" ? normalized : "";
      if (mediaType === "video") {
        try {
          const parent = node && node.parentElement;
          const posterNode = tag === "source" &&
            safeText(parent && (parent.localName || parent.tagName), 20).toLowerCase() === "video"
            ? parent
            : node;
          const posterValue = getAttribute(posterNode, "poster");
          if (!posterValue) {
            throw new Error("No poster");
          }
          const poster = new URL(posterValue, pageUrl);
          previewUrl = ["http:", "https:"].includes(poster.protocol) ? poster.href : "";
        } catch (_error) {
          previewUrl = "";
        }
      }
      if (found.has(normalized) || payloadLength + normalized.length > maxPayloadLength) {
        return found.has(normalized);
      }
      payloadLength += normalized.length;
      found.set(normalized, {
        url: normalized,
        previewUrl,
        alt: getAttribute(node, "alt") || getAttribute(node, "title"),
        title: getAttribute(node, "title"),
        width: finiteInteger(getAttribute(node, "width"), 0, 0, 1000000),
        height: finiteInteger(getAttribute(node, "height"), 0, 0, 1000000),
        mimeType: type,
        mediaType,
        kinds: [mediaType === "video" ? "Tracked page video" : "Tracked page image"]
      });
      return true;
    }

    for (const node of nodes) {
      if (found.size >= maxItems || payloadLength >= maxPayloadLength) {
        break;
      }
      const tag = safeText(node && (node.localName || node.tagName), 20).toLowerCase();
      const candidates = [
        getAttribute(node, "data-full"),
        getAttribute(node, "data-full-src"),
        getAttribute(node, "data-original"),
        getAttribute(node, "data-original-src"),
        getAttribute(node, "data-lazy-src"),
        getAttribute(node, "data-src"),
        candidateFromSrcset(getAttribute(node, "data-srcset")),
        candidateFromSrcset(getAttribute(node, "srcset")),
        getAttribute(node, "src")
      ];
      if (tag === "a") {
        candidates.unshift(getAttribute(node, "href"));
      } else if (tag === "image") {
        candidates.push(getAttribute(node, "href"), getAttribute(node, "xlink:href"));
      }
      const style = getAttribute(node, "style");
      let addedPrimary = false;
      for (const candidate of candidates) {
        if (candidate && add(candidate, node, getAttribute(node, "type"))) {
          addedPrimary = true;
          break;
        }
      }
      if (!addedPrimary || !["image", "img", "video", "source", "input", "a"].includes(tag)) {
        for (const match of style.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
          add(match[2], node, getAttribute(node, "type"));
        }
      }
    }
    return Array.from(found.values());
  }

  function normalizeReviewItem(value, fallbackTime) {
    const tracker = trackerId(safeProperty(value, "trackerId"));
    const fingerprint = safeText(safeProperty(value, "fingerprint"), 40).toLowerCase();
    const url = normalizePageUrl(safeProperty(value, "url"));
    if (!tracker || !/^[a-f0-9]{16}$/.test(fingerprint) || !url) {
      return null;
    }
    const previewUrl = normalizePageUrl(safeProperty(value, "previewUrl"));
    return {
      id: `${tracker}:${fingerprint}`,
      trackerId: tracker,
      fingerprint,
      url,
      previewUrl,
      identityKey: safeText(safeProperty(value, "identityKey"), 300),
      mediaType: safeText(safeProperty(value, "mediaType"), 20).toLowerCase() === "video"
        ? "video"
        : "image",
      filename: safeText(safeProperty(value, "filename"), 180),
      sourceFilename: safeText(safeProperty(value, "sourceFilename"), 180),
      alt: safeText(safeProperty(value, "alt"), 500),
      title: safeText(safeProperty(value, "title"), 500),
      width: finiteInteger(safeProperty(value, "width"), 0, 0, 1000000),
      height: finiteInteger(safeProperty(value, "height"), 0, 0, 1000000),
      mimeType: safeText(safeProperty(value, "mimeType"), 100),
      detectedAt: boundedTime(safeProperty(value, "detectedAt")) || boundedTime(fallbackTime) || Date.now(),
      pageTitle: safeText(safeProperty(value, "pageTitle"), 300),
      pageUrl: normalizePageUrl(safeProperty(value, "pageUrl"))
    };
  }

  function reviewPayloadLength(item) {
    return [
      item.url,
      item.previewUrl,
      item.identityKey,
      item.filename,
      item.sourceFilename,
      item.alt,
      item.title,
      item.pageTitle,
      item.pageUrl
    ].reduce((total, value) => total + String(value || "").length, 0);
  }

  function normalizeReviewItems(value) {
    const items = [];
    const ids = new Set();
    let payloadLength = 0;
    const normalized = (Array.isArray(value) ? value : [])
      .map((item) => normalizeReviewItem(item, 0))
      .filter(Boolean)
      .sort((left, right) => right.detectedAt - left.detectedAt);
    for (const item of normalized) {
      const length = reviewPayloadLength(item);
      if (
        ids.has(item.id) ||
        items.length >= MAX_REVIEW_ITEMS ||
        payloadLength + length > MAX_REVIEW_PAYLOAD_LENGTH
      ) {
        continue;
      }
      ids.add(item.id);
      payloadLength += length;
      items.push(item);
    }
    return items;
  }

  function addReviewItems(existing, additions, nowValue) {
    const now = boundedTime(nowValue) || Date.now();
    const items = normalizeReviewItems(existing);
    const byId = new Map(items.map((item, index) => [item.id, index]));
    let payloadLength = items.reduce((total, item) => total + reviewPayloadLength(item), 0);
    const acceptedIds = [];
    const rejected = [];
    for (const raw of Array.isArray(additions) ? additions : []) {
      const item = normalizeReviewItem(raw, now);
      if (!item) {
        rejected.push({ id: "", error: "The review item is invalid." });
        continue;
      }
      const existingIndex = byId.get(item.id);
      if (existingIndex !== undefined) {
        const previous = items[existingIndex];
        payloadLength -= reviewPayloadLength(previous);
        item.detectedAt = previous.detectedAt;
        if (payloadLength + reviewPayloadLength(item) > MAX_REVIEW_PAYLOAD_LENGTH) {
          payloadLength += reviewPayloadLength(previous);
          rejected.push({ id: item.id, error: "The review inbox URL limit was reached." });
          continue;
        }
        items[existingIndex] = item;
        payloadLength += reviewPayloadLength(item);
        acceptedIds.push(item.id);
        continue;
      }
      const length = reviewPayloadLength(item);
      if (items.length >= MAX_REVIEW_ITEMS || payloadLength + length > MAX_REVIEW_PAYLOAD_LENGTH) {
        rejected.push({ id: item.id, error: "The review inbox is full." });
        continue;
      }
      byId.set(item.id, items.length);
      items.push(item);
      payloadLength += length;
      acceptedIds.push(item.id);
    }
    return {
      items: normalizeReviewItems(items),
      acceptedIds,
      rejected
    };
  }

  function removeReviewItems(existing, ids) {
    const remove = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => safeText(id, 160)));
    return normalizeReviewItems(existing).filter((item) => !remove.has(item.id));
  }

  return Object.freeze({
    STORAGE_KEY,
    REVIEW_STORAGE_KEY,
    ALARM_PREFIX,
    MAX_TRACKERS,
    MAX_SEEN,
    MAX_ITEMS_PER_SCAN,
    MAX_DOWNLOADS_PER_RUN,
    MAX_ACTIVITY,
    MAX_REVIEW_ITEMS,
    MAX_REVIEW_PAYLOAD_LENGTH,
    MAX_PATTERNS,
    MAX_PAGES_PER_RUN,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
    MAX_HTML_BYTES,
    REQUEST_TIMEOUT_MS,
    normalizePageUrl,
    permissionPatternForUrl,
    normalizeTracker,
    normalizeTrackers,
    normalizeMatching,
    normalizePagination,
    normalizeNotifications,
    normalizeAction,
    normalizeActivity,
    appendActivity,
    stableMediaValue,
    mediaFingerprint,
    recordSeen,
    matchesQuery,
    wildcardMatches,
    matchesTrackerRules,
    pageUrlFromTemplate,
    extractNextPageUrl,
    extractMediaFromDocument,
    normalizeReviewItem,
    normalizeReviewItems,
    addReviewItems,
    removeReviewItems
  });
});
