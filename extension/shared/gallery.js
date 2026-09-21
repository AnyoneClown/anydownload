(function attachGallery(root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./download-ledger.js"));
  } else {
    root.AnyDownloadGallery = factory(root.ImageDownloaderCore, root.AnyDownloadLedger);
  }
})(globalThis, function createGallery(Core, Ledger) {
  "use strict";

  const STORAGE_KEY = "siteGalleries:v1";
  const MAX_SITES = 20;
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_SITE_BYTES = 3 * 1024 * 1024;
  const MAX_PAGES = 10;
  const MAX_STEPS = 120;
  const MAX_DURATION_MS = 5 * 60 * 1000;

  function pageUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (!Core.siteKeyForUrl(url.href) || url.username || url.password || url.href.length > 16384) {
        return "";
      }
      if (url.origin !== "https://web.telegram.org") url.hash = "";
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function mediaUrl(value) {
    const result = Core.validateMediaUrl(value);
    if (!result.ok) {
      return "";
    }
    return result.value.startsWith("data:") ? result.value : pageUrl(result.value);
  }

  function youtubeUrl(image) {
    if (image && image.sourceProvider === "youtube" &&
      /^[A-Za-z0-9_-]{11}$/.test(image.videoId) &&
      Number.isSafeInteger(image.itag) && image.itag > 0 && image.itag <= 1000000) {
      return `https://www.youtube.com/watch?v=${image.videoId}&anydownload_provider=youtube&anydownload_itag=${image.itag}`;
    }
    return "";
  }

  function isGoogleVideo(value) {
    try {
      return /(^|\.)googlevideo\.com$/i.test(new URL(value).hostname);
    } catch (_error) {
      return false;
    }
  }

  function normalizeRecord(value, siteKey) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const sourceUrl = pageUrl(value.pageUrl);
    // Telegram files belong to an open tab/session and must be rescanned.
    if (/^https:\/\/web\.telegram\.org\//i.test(sourceUrl)) return null;
    if (Core.siteKeyForUrl(sourceUrl) !== siteKey) {
      return null;
    }
    const providerUrl = youtubeUrl(value);
    const url = providerUrl || mediaUrl(value.url);
    if (!url || isGoogleVideo(url)) {
      return null;
    }
    const record = {
      url,
      identityKey: String(value.identityKey || "").slice(0, 300),
      previewUrl: isGoogleVideo(value.previewUrl) ? "" : mediaUrl(value.previewUrl),
      pageUrl: sourceUrl,
      pageTitle: String(value.pageTitle || "").slice(0, 300),
      selected: value.selected === true,
      mediaType: value.mediaType === "video" ? "video" : "image"
    };
    for (const key of ["filename", "alt", "mimeType", "sourceProvider", "videoId", "qualityLabel"]) {
      record[key] = String(value[key] || "").slice(0, key === "alt" || key === "filename" ? 500 : 100);
    }
    for (const key of ["width", "height", "duration", "itag"]) {
      record[key] = Math.max(0, Math.min(1000000, Number(value[key]) || 0));
    }
    record.hasAudio = typeof value.hasAudio === "boolean" ? value.hasAudio : null;
    if (value.originalMediaType === 1 && record.mediaType === "image" && record.sourceProvider === "instagram") {
      record.originalMediaType = 1;
    }
    record.kinds = (Array.isArray(value.kinds) ? value.kinds : []).slice(0, 8)
      .map((kind) => String(kind).slice(0, 50));
    record.instagramCollections = (Array.isArray(value.instagramCollections) ? value.instagramCollections : [])
      .slice(0, 32).filter((item) => item && ["post", "story", "highlight"].includes(item.type))
      .map((item) => ({
        type: item.type, id: String(item.id || "").slice(0, 100),
        title: String(item.title || "").slice(0, 120), owner: String(item.owner || "").slice(0, 80)
      }));
    if (providerUrl) {
      record.identityKey = `youtube:${record.videoId}:${record.itag}`;
    }
    return record;
  }

  function recordKey(record) {
    return Ledger.mediaFingerprint(record);
  }

  function byteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  function normalizeSite(value) {
    const siteKey = Core.siteKeyForUrl(pageUrl(value && value.siteKey));
    if (!siteKey) {
      return null;
    }
    const records = new Map();
    let bytes = 0;
    let urls = 0;
    let trimmed = false;
    for (const raw of (Array.isArray(value.records) ? value.records : []).slice(0, Core.MAX_BATCH_SIZE * 2)) {
      let record = normalizeRecord(raw, siteKey);
      if (!record) {
        continue;
      }
      const key = recordKey(record);
      const previous = records.get(key);
      if (previous && previous.originalMediaType === 1 && record.originalMediaType !== 1) {
        record = { ...previous, selected: record.selected };
      }
      const addedBytes = byteLength(record) - (previous ? byteLength(previous) : 0);
      const addedUrls = record.url.length + record.previewUrl.length -
        (previous ? previous.url.length + previous.previewUrl.length : 0);
      if ((!previous && records.size >= Core.MAX_BATCH_SIZE) ||
        bytes + addedBytes > MAX_SITE_BYTES || urls + addedUrls > Core.MAX_BATCH_TOTAL_URL_LENGTH) {
        trimmed = true;
        continue;
      }
      records.set(key, record);
      bytes += addedBytes;
      urls += addedUrls;
    }
    return {
      siteKey,
      epoch: Number.isSafeInteger(value.epoch) && value.epoch >= 0 ? value.epoch : 0,
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      records: Array.from(records.values()),
      trimmed
    };
  }

  function getSite(sites, siteKey) {
    return normalizeSite((Array.isArray(sites) ? sites : []).find((site) => site && site.siteKey === siteKey) ||
      { siteKey, records: [] });
  }

  function updateSites(sites, message, now = Date.now()) {
    const current = getSite(sites, message.siteKey);
    if (!current) {
      throw new Error("A saved gallery must belong to an HTTP(S) website.");
    }
    if (message.action !== "clear" && message.epoch !== current.epoch) {
      return { sites, gallery: current, stale: true };
    }
    const gallery = normalizeSite({
      ...current,
      epoch: message.action === "clear" ? current.epoch + 1 : current.epoch,
      updatedAt: now,
      records: message.action === "clear" ? [] : [
        ...current.records,
        ...(Array.isArray(message.records) ? message.records.slice(0, Core.MAX_BATCH_SIZE) : [])
      ]
    });
    const remaining = (Array.isArray(sites) ? sites : []).filter((site) => site && site.siteKey !== gallery.siteKey)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const kept = [gallery];
    let bytes = byteLength(gallery);
    for (const raw of remaining.slice(0, MAX_SITES)) {
      const site = normalizeSite(raw);
      if (site && kept.length < MAX_SITES && bytes + byteLength(site) <= MAX_BYTES) {
        kept.push(site);
        bytes += byteLength(site);
      }
    }
    return { sites: kept, gallery, stale: false };
  }

  // This function is serialized into the source tab; keep it self-contained.
  function scrollPage(expectedUrl, allowLoadMore, restart) {
    if (location.href.split("#")[0] !== String(expectedUrl).split("#")[0]) {
      throw new Error("The source page changed. Collected media has been kept.");
    }
    const root = document.scrollingElement || document.documentElement;
    const height = root.scrollHeight;
    const top = root.scrollTop;
    const viewport = root.clientHeight || window.innerHeight || 600;
    root.scrollTo({ top: restart ? 0 : top + Math.max(300, viewport * 0.8), behavior: "instant" });
    const bottom = root.scrollTop + viewport >= height - 4;
    const more = bottom && allowLoadMore && Array.from(document.querySelectorAll(
      'button, .js_see-more[data-get="photos"][data-type="group"]'
    )).slice(0, 500)
      .find((button) => !button.disabled && !button.form && !button.closest("form") &&
        button.getAttribute("aria-disabled") !== "true" &&
        button.getClientRects().length && /^(?:load|show|see) more(?: (?:images|photos|videos|media|posts|results))?$/i
          .test(String(button.textContent || "").trim()));
    if (more) {
      more.click();
    }
    const nextLinks = Array.from(document.querySelectorAll(
      "a[rel~='next'],link[rel~='next'],a.next,.pagination a.next,.pager a.next,a[aria-label*='next' i]"
    )).slice(0, 30).map((node) => node.href || node.getAttribute("href"));
    return {
      top: root.scrollTop, height,
      bottom, clickedMore: Boolean(more),
      nextLinks
    };
  }

  // Fetch in the source tab to retain its session, including private context.
  async function fetchPage(urlValue, expectedUrl) {
    const source = new URL(location.href);
    const url = new URL(urlValue);
    if (source.href.split("#")[0] !== String(expectedUrl).split("#")[0] ||
      url.origin !== source.origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Collection can only follow pages on the original website.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const limit = 4 * 1024 * 1024;
    try {
      const response = await fetch(url.href, {
        credentials: "include", redirect: "error", signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
      if (!response.ok) {
        throw new Error(`The next page returned HTTP ${response.status}.`);
      }
      if (response.url && new URL(response.url).origin !== source.origin) {
        throw new Error("The next page redirected to another website.");
      }
      if (!/(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") || "text/html") ||
        Number(response.headers.get("content-length")) > limit) {
        throw new Error("The next page is not HTML or exceeds the 4 MB limit.");
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("Firefox cannot read the next page within the collection size limit.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let html = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > limit) {
          await reader.cancel();
          throw new Error("The next page exceeds the 4 MB limit.");
        }
        html += decoder.decode(chunk.value, { stream: true });
      }
      return { html: html + decoder.decode(), bytes, url: url.href };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  return {
    STORAGE_KEY, MAX_SITES, MAX_BYTES, MAX_PAGES, MAX_STEPS, MAX_DURATION_MS,
    pageUrl, youtubeUrl, normalizeRecord, recordKey, normalizeSite, getSite, updateSites, scrollPage, fetchPage
  };
});
