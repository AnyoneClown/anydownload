(function initializeDownloadBackground() {
  "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const collectImagesFromPage = globalThis.ImageDownloaderCollector;
  const Instagram = globalThis.ImageDownloaderInstagram;
  const collectInstagramMediaFromPage = Instagram && Instagram.collectFromPage;
  const YouTube = globalThis.AnyDownloadYouTube;
  const collectYouTubeMediaFromPage = globalThis.AnyDownloadYouTubeCollector ||
    (YouTube && YouTube.collectYouTubeMediaFromPage);
  const Archive = globalThis.ImageDownloaderArchive;
  const Templates = globalThis.ImageDownloaderTemplates;
  const DownloadQueue = globalThis.ImageDownloaderDownloadQueue;
  const MAX_CONCURRENCY = 5;
  const QUEUE_CONCURRENCY = 3;
  const QUEUE_STORAGE_KEY = "downloadQueueState:v1";
  const MAX_ARCHIVE_ITEMS = 2000;
  const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
  const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;
  const MAX_ARCHIVE_FETCH_CONCURRENCY = 2;
  const MAX_ARCHIVE_FETCH_TIMEOUT_MS = 120000;
  const DOWNLOAD_RETENTION_POLL_MS = 1000;
  const DOWNLOAD_RETENTION_MAX_MS = 24 * 60 * 60 * 1000;
  const MAX_IGNORED_PER_SITE = 500;
  const MAX_IGNORED_RULES = 5000;
  const VIDEO_FILE_EXTENSION = /\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)$/i;
  const VIDEO_FILE_FORMATS = new Set(["m4v", "mkv", "mov", "mp4", "ogg", "ogv", "webm"]);
  const IGNORE_STORAGE_PREFIX = "ignoredImage:";
  const MANAGER_WINDOW_STORAGE_PREFIX = "imageManagerWindow:";
  const MANAGER_WINDOW_WIDTH = 800;
  const MANAGER_WINDOW_HEIGHT = 720;
  const MENU_IDS = Object.freeze({
    root: "anydownload-image-actions",
    download: "anydownload-download-image",
    preview: "anydownload-preview-image",
    ignore: "anydownload-ignore-image",
    separator: "anydownload-image-separator",
    open: "anydownload-open-popup"
  });
  const retainedObjectUrls = new Map();
  const badgeTimers = new Map();
  const managerWindowQueues = new Map();
  const downloadQueueContexts = new Map();
  const youtubeResolutionCache = new Map();
  let archiveInProgress = false;

  function acknowledgeMenuCreation() {
    // Reading lastError prevents duplicate-ID errors from becoming uncaught when
    // a non-persistent background page wakes and the persisted menus still exist.
    void browser.runtime.lastError;
  }

  function createContextMenus() {
    if (!browser.menus || typeof browser.menus.create !== "function") {
      return;
    }
    const common = { contexts: ["image", "video"] };
    const entries = [
      { id: MENU_IDS.root, title: "AnyDownload", ...common },
      {
        id: MENU_IDS.download,
        parentId: MENU_IDS.root,
        title: "Download media",
        ...common
      },
      {
        id: MENU_IDS.preview,
        parentId: MENU_IDS.root,
        title: "Preview media",
        ...common
      },
      {
        id: MENU_IDS.ignore,
        parentId: MENU_IDS.root,
        title: "Ignore media on this site",
        ...common
      },
      {
        id: MENU_IDS.separator,
        parentId: MENU_IDS.root,
        type: "separator",
        ...common
      },
      {
        id: MENU_IDS.open,
        parentId: MENU_IDS.root,
        title: "Open media list…",
        ...common
      }
    ];
    for (const entry of entries) {
      browser.menus.create(entry, acknowledgeMenuCreation);
    }
  }

  async function rebuildContextMenus() {
    if (!browser.menus || typeof browser.menus.removeAll !== "function") {
      return;
    }
    await browser.menus.removeAll();
    createContextMenus();
  }

  function managerWindowStorageKey(incognito) {
    return `${MANAGER_WINDOW_STORAGE_PREFIX}${incognito ? "private" : "normal"}`;
  }

  function managerWindowUrl(sourceTabId, options = {}) {
    const launch = encodeURIComponent(createPreviewId());
    const live = options.liveCapture === true ? "&live=1" : "";
    return browser.runtime.getURL(
      `popup/popup.html?sourceTabId=${encodeURIComponent(String(sourceTabId))}&launch=${launch}${live}`
    );
  }

  async function fallbackToManagerTab(url, tab) {
    if (!browser.tabs || typeof browser.tabs.create !== "function") {
      throw new Error("Firefox cannot open the AnyDownload media window.");
    }
    const createProperties = { active: true, url };
    if (Number.isInteger(tab && tab.windowId)) {
      createProperties.windowId = tab.windowId;
    }
    return browser.tabs.create(createProperties);
  }

  function openResizableImageWindow(tab, options = {}) {
    if (!tab || !Number.isInteger(tab.id)) {
      return Promise.reject(new Error("Firefox did not identify the source tab."));
    }

    const incognito = Boolean(tab.incognito);
    const storageKey = managerWindowStorageKey(incognito);
    const previous = managerWindowQueues.get(storageKey) || Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const url = managerWindowUrl(tab.id, options);
      let stored = null;
      try {
        const values = await browser.storage.session.get(storageKey);
        stored = values && values[storageKey];
      } catch (_error) {
        // Session storage is an optimization; a fresh manager can still open.
      }

      const canReuse = Boolean(
        stored &&
        Number.isInteger(stored.windowId) &&
        Number.isInteger(stored.tabId) &&
        Boolean(stored.incognito) === incognito &&
        browser.windows &&
        typeof browser.windows.get === "function" &&
        typeof browser.windows.update === "function" &&
        browser.tabs &&
        typeof browser.tabs.update === "function"
      );
      if (canReuse) {
        try {
          const managerWindow = await browser.windows.get(stored.windowId);
          if (!managerWindow || Boolean(managerWindow.incognito) !== incognito) {
            throw new Error("The saved manager window belongs to a different browsing context.");
          }
          await browser.tabs.update(stored.tabId, { active: true, url });
          await browser.windows.update(stored.windowId, { focused: true });
          return { reused: true, windowId: stored.windowId, tabId: stored.tabId };
        } catch (_error) {
          await browser.storage.session.remove(storageKey).catch(() => undefined);
        }
      } else if (stored) {
        await browser.storage.session.remove(storageKey).catch(() => undefined);
      }

      if (browser.windows && typeof browser.windows.create === "function") {
        try {
          const managerWindow = await browser.windows.create({
            url,
            type: "popup",
            width: MANAGER_WINDOW_WIDTH,
            height: MANAGER_WINDOW_HEIGHT,
            focused: true,
            incognito
          });
          const managerTab = managerWindow && Array.isArray(managerWindow.tabs)
            ? managerWindow.tabs[0]
            : null;
          if (managerWindow && Number.isInteger(managerWindow.id) && managerTab && Number.isInteger(managerTab.id)) {
            await browser.storage.session.set({
              [storageKey]: {
                windowId: managerWindow.id,
                tabId: managerTab.id,
                incognito
              }
            }).catch(() => undefined);
          }
          return { reused: false, windowId: managerWindow && managerWindow.id };
        } catch (_error) {
          // Firefox Android and restricted environments may not support popup windows.
        }
      }

      await browser.storage.session.remove(storageKey).catch(() => undefined);
      const fallbackTab = await fallbackToManagerTab(url, tab);
      return { reused: false, tabId: fallbackTab && fallbackTab.id, fallback: true };
    });

    managerWindowQueues.set(storageKey, queued);
    queued.finally(() => {
      if (managerWindowQueues.get(storageKey) === queued) {
        managerWindowQueues.delete(storageKey);
      }
    }).catch(() => undefined);
    return queued;
  }

  function showActionFeedback(tabId, success) {
    if (!Number.isInteger(tabId) || !browser.action) {
      return;
    }
    const previousTimer = badgeTimers.get(tabId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }
    Promise.all([
      browser.action.setBadgeBackgroundColor({
        tabId,
        color: success ? "#087443" : "#b42318"
      }),
      browser.action.setBadgeText({ tabId, text: success ? "✓" : "!" })
    ]).catch(() => undefined);
    const timer = setTimeout(() => {
      badgeTimers.delete(tabId);
      browser.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    }, 2500);
    badgeTimers.set(tabId, timer);
  }

  function normalizedMediaUrl(value) {
    const validator = Core.validateMediaUrl || Core.validateDownloadUrl;
    const result = validator(value);
    return result.ok ? result.value : "";
  }

  function isStreamingVideoManifestUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (/\.(?:m3u8|mpd)$/i.test(parsed.pathname)) {
        return true;
      }
      const format = (parsed.searchParams.get("format") || parsed.searchParams.get("fm") || "")
        .toLowerCase()
        .replace(/^(?:application|video)\//, "");
      return ["dash+xml", "dash", "hls", "m3u8", "mpd", "mpegurl", "vnd.apple.mpegurl", "x-mpegurl"]
        .includes(format);
    } catch (_error) {
      return false;
    }
  }

  function safeContextMedia(image) {
    const url = normalizedMediaUrl(image && image.url);
    if (!url) {
      return null;
    }
    return {
      url,
      previewUrl: normalizedMediaUrl(image && image.previewUrl),
      filename: String(image && image.filename || "").slice(0, 500),
      alt: String(image && image.alt || "").slice(0, 500),
      width: Math.max(0, Number(image && image.width) || 0),
      height: Math.max(0, Number(image && image.height) || 0),
      duration: Math.max(0, Number(image && image.duration) || 0),
      mediaType: image && image.mediaType === "video" ? "video" : "image",
      mimeType: String(image && image.mimeType || "").slice(0, 100),
      sourceProvider: String(image && image.sourceProvider || "").slice(0, 50),
      videoId: /^[A-Za-z0-9_-]{11}$/.test(String(image && image.videoId || ""))
        ? String(image.videoId)
        : "",
      qualityLabel: String(image && image.qualityLabel || "").slice(0, 40),
      hasAudio: typeof (image && image.hasAudio) === "boolean" ? image.hasAudio : null,
      itag: Math.max(0, Math.round(Number(image && image.itag) || 0)),
      kinds: Array.from(image && image.kinds || [])
        .slice(0, 8)
        .map((kind) => String(kind).slice(0, 50))
    };
  }

  function isYouTubeVideoPageUrl(value) {
    return Boolean(
      YouTube &&
      typeof YouTube.isYouTubeUrl === "function" &&
      YouTube.isYouTubeUrl(value) &&
      /(?:[?&]v=[A-Za-z0-9_-]{11}(?:[&#]|$)|\/(?:embed|live|shorts|v)\/[A-Za-z0-9_-]{11}(?:[/?#]|$)|youtu\.be\/[A-Za-z0-9_-]{11}(?:[/?#]|$))/i.test(String(value || ""))
    );
  }

  function youtubeVideoIdFromPageUrl(value) {
    if (!isYouTubeVideoPageUrl(value)) {
      return "";
    }
    try {
      const parsed = new URL(String(value || ""));
      const queryId = String(parsed.searchParams.get("v") || "");
      if (/^[A-Za-z0-9_-]{11}$/.test(queryId)) {
        return queryId;
      }
      const parts = parsed.pathname.split("/").filter(Boolean);
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      const candidate = hostname === "youtu.be"
        ? parts[0]
        : ["embed", "live", "shorts", "v"].includes(String(parts[0] || "").toLowerCase())
          ? parts[1]
          : "";
      return /^[A-Za-z0-9_-]{11}$/.test(String(candidate || "")) ? candidate : "";
    } catch (_error) {
      return "";
    }
  }

  function youtubeQueueUrl(pageUrl, mediaUrl, mediaType) {
    const videoId = mediaType === "video" ? youtubeVideoIdFromPageUrl(pageUrl) : "";
    if (!videoId) {
      return "";
    }
    try {
      const media = new URL(String(mediaUrl || ""));
      const hostname = media.hostname.toLowerCase().replace(/\.$/, "");
      if (media.protocol !== "https:" ||
        (hostname !== "googlevideo.com" && !hostname.endsWith(".googlevideo.com"))) {
        return "";
      }
      const itag = Number(media.searchParams.get("itag"));
      const queued = new URL("https://www.youtube.com/watch");
      queued.searchParams.set("v", videoId);
      queued.searchParams.set("anydownload_provider", "youtube");
      if (Number.isSafeInteger(itag) && itag > 0 && itag <= 1000000) {
        queued.searchParams.set("anydownload_itag", String(itag));
      }
      return queued.href;
    } catch (_error) {
      return "";
    }
  }

  function youtubeQueueTaskDetails(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname.toLowerCase().replace(/\.$/, "") !== "www.youtube.com" ||
        parsed.pathname !== "/watch" ||
        parsed.searchParams.get("anydownload_provider") !== "youtube"
      ) {
        return null;
      }
      const videoId = String(parsed.searchParams.get("v") || "");
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return null;
      }
      const rawItag = Number(parsed.searchParams.get("anydownload_itag"));
      return {
        videoId,
        itag: Number.isSafeInteger(rawItag) && rawItag > 0 && rawItag <= 1000000
          ? rawItag
          : 0,
        pageUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
      };
    } catch (_error) {
      return null;
    }
  }

  function validatedGoogleVideoUrl(value) {
    const normalized = normalizedMediaUrl(value);
    if (!normalized) {
      return "";
    }
    try {
      const parsed = new URL(normalized);
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      return parsed.protocol === "https:" &&
        (hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com"))
        ? normalized
        : "";
    } catch (_error) {
      return "";
    }
  }

  async function resolveQueueMediaUrl(task) {
    const details = youtubeQueueTaskDetails(task && task.url);
    if (!details) {
      return task.url;
    }
    if (typeof collectYouTubeMediaFromPage !== "function") {
      throw new Error("The YouTube direct-file resolver is unavailable.");
    }

    const now = Date.now();
    if (Number(task && task.attempt) > 1) {
      youtubeResolutionCache.delete(details.videoId);
    }
    let cached = youtubeResolutionCache.get(details.videoId);
    if (!cached || cached.expiresAt <= now) {
      const scan = await collectYouTubeMediaFromPage({
        pageUrl: details.pageUrl,
        pageTitle: String(task && task.filename || "YouTube video").slice(0, 300),
        includeVideoOnly: true,
        maxFormats: 24,
        maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH,
        maxResponses: 1,
        maxScripts: 0,
        maxResponseBytes: 8000000,
        requestTimeoutMs: 10000
      });
      const images = scan && Array.isArray(scan.images)
        ? scan.images.filter((image) => image && image.mediaType === "video")
        : [];
      if (!images.length) {
        const explanation = scan && Array.isArray(scan.warnings)
          ? scan.warnings.map((warning) => String(warning).slice(0, 500)).join(" ")
          : "";
        throw new Error(explanation || "YouTube did not expose a complete direct video file.");
      }
      cached = { images, expiresAt: now + 120000 };
      if (youtubeResolutionCache.size >= 16) {
        youtubeResolutionCache.delete(youtubeResolutionCache.keys().next().value);
      }
      youtubeResolutionCache.set(details.videoId, cached);
    }

    const selected = details.itag
      ? cached.images.find((image) => Number(image.itag) === details.itag)
      : null;
    const candidate = selected ||
      cached.images.find((image) => image.hasAudio === true) ||
      cached.images[0];
    const directUrl = validatedGoogleVideoUrl(candidate && candidate.url);
    if (!directUrl) {
      throw new Error("YouTube returned an invalid direct video URL.");
    }
    return directUrl;
  }

  function downloadHeadersForSource(value) {
    try {
      const parsed = new URL(String(value || ""));
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) {
        return [{ name: "Referer", value: "https://www.instagram.com/" }];
      }
    } catch (_error) {
      // Unknown sources receive no extra request headers.
    }
    return [];
  }

  function preferredFilenameForMedia(image, index) {
    const mediaType = image && image.mediaType === "video" ? "video" : "image";
    const inferred = (Core.filenameForMedia || Core.filenameForImage)(
      image && image.url,
      index,
      mediaType
    );
    const suggested = String(image && image.filename || "").slice(0, 500).trim();
    const recognized = mediaType === "video"
      ? /\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)$/i.test(suggested)
      : /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(suggested);
    return recognized ? Core.sanitizeFilename(suggested, inferred) : inferred;
  }

  async function resolveContextMedia(info, tab) {
    const requestedMediaType = info && info.mediaType === "video" ? "video" : "image";
    const sourceUrl = normalizedMediaUrl(info && info.srcUrl);
    let specializedError = "";
    if (
      requestedMediaType === "video" &&
      tab &&
      Number.isInteger(tab.id) &&
      Instagram &&
      typeof Instagram.isInstagramUrl === "function" &&
      typeof collectInstagramMediaFromPage === "function" &&
      Instagram.isInstagramUrl(tab.url)
    ) {
      try {
        const instagramResults = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: collectInstagramMediaFromPage,
          args: [{
            includeRelated: false,
            maxItems: Core.MAX_BATCH_SIZE,
            maxDocuments: 1,
            maxDocumentBytes: 4000000,
            maxTotalDocumentBytes: 4000000,
            maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH
          }]
        });
        const instagramScan = instagramResults && instagramResults[0] && instagramResults[0].result;
        const videos = instagramScan && Array.isArray(instagramScan.images)
          ? instagramScan.images.map(safeContextMedia)
            .filter((image) => image && image.mediaType === "video")
          : [];
        const exact = videos.find((image) =>
          sourceUrl && (image.url === sourceUrl || image.previewUrl === sourceUrl)
        );
        if (exact || videos.length === 1) {
          return exact || videos[0];
        }
        specializedError = videos.length > 1
          ? "This Instagram carousel contains multiple videos; open the media list to choose the correct item."
          : instagramScan && Array.isArray(instagramScan.warnings)
            ? instagramScan.warnings.map((warning) => String(warning).slice(0, 500)).join(" ")
            : "";
      } catch (error) {
        specializedError = `Instagram-specific collection failed: ${error.message || error}`;
      }
    }
    if (
      requestedMediaType === "video" &&
      tab &&
      Number.isInteger(tab.id) &&
      typeof collectYouTubeMediaFromPage === "function" &&
      isYouTubeVideoPageUrl(tab.url)
    ) {
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
        const youtubeScan = youtubeResults && youtubeResults[0] && youtubeResults[0].result;
        const discovered = youtubeScan && Array.isArray(youtubeScan.images)
          ? youtubeScan.images.map(safeContextMedia).filter(Boolean)
          : [];
        const complete = discovered.find((image) => image.mediaType === "video" && image.hasAudio);
        const video = complete || discovered.find((image) => image.mediaType === "video");
        if (video) {
          return video;
        }
        specializedError = youtubeScan && Array.isArray(youtubeScan.warnings)
          ? youtubeScan.warnings.map((warning) => String(warning).slice(0, 500)).join(" ")
          : "";
      } catch (error) {
        specializedError = `YouTube-specific collection failed: ${error.message || error}`;
      }
    }
    if (tab && Number.isInteger(tab.id) && typeof collectImagesFromPage === "function") {
      const target = { tabId: tab.id };
      if (Number.isInteger(info && info.frameId)) {
        target.frameIds = [info.frameId];
      }
      try {
        const injectionResults = await browser.scripting.executeScript({
          target,
          func: collectImagesFromPage,
          args: [{
            includeBackgrounds: false,
            maxImages: Core.MAX_BATCH_SIZE,
            maxElements: 10000,
            maxDataUrlLength: 500000,
            maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH,
            targetElementId: Number.isInteger(info && info.targetElementId)
              ? info.targetElementId
              : null
          }]
        });
        const discovered = injectionResults
          .flatMap((injection) => injection && injection.result && Array.isArray(injection.result.images)
            ? injection.result.images
            : [])
          .map(safeContextMedia)
          .filter(Boolean);
        const exact = discovered.find((image) =>
          sourceUrl && (image.url === sourceUrl || image.previewUrl === sourceUrl)
        );
        if (exact) {
          return exact;
        }
        const matchingType = discovered.filter((item) => item.mediaType === requestedMediaType);
        if (Number.isInteger(info && info.targetElementId) && matchingType.length === 1) {
          return matchingType[0];
        }
      } catch (_error) {
        // Fall back to Firefox's srcUrl when a protected page/frame blocks injection.
      }
    }
    if (!sourceUrl) {
      throw new Error(specializedError || "Firefox did not expose a downloadable URL for this media item.");
    }
    if (requestedMediaType === "video" && isStreamingVideoManifestUrl(sourceUrl)) {
      throw new Error("This player exposes a streaming manifest, not a standalone video file.");
    }
    return {
      url: sourceUrl,
      previewUrl: "",
      alt: "",
      width: 0,
      height: 0,
      duration: 0,
      mediaType: requestedMediaType,
      mimeType: "",
      kinds: [requestedMediaType === "video" ? "Context video" : "Context image"]
    };
  }

  function createPreviewId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const random = crypto.getRandomValues(new Uint32Array(2));
    return `${Date.now().toString(36)}-${random[0].toString(36)}-${random[1].toString(36)}`;
  }

  async function openContextPreview(image, tab) {
    const id = createPreviewId();
    const key = `imagePreview:${id}`;
    await browser.storage.session.set({
      [key]: {
        url: image.url,
        previewUrl: image.previewUrl,
        name: preferredFilenameForMedia(image, 0),
        alt: image.alt,
        mediaType: image.mediaType,
        duration: image.duration,
        createdAt: Date.now()
      }
    });
    const createProperties = {
      active: true,
      url: browser.runtime.getURL(`preview/preview.html?id=${encodeURIComponent(id)}`)
    };
    if (tab && Number.isInteger(tab.windowId)) {
      createProperties.windowId = tab.windowId;
    }
    try {
      await browser.tabs.create(createProperties);
    } catch (error) {
      await browser.storage.session.remove(key).catch(() => undefined);
      throw error;
    }
  }

  function ignoreStoragePrefix(siteKey) {
    return `${IGNORE_STORAGE_PREFIX}${encodeURIComponent(siteKey)}:`;
  }

  async function storeContextIgnoreRule(image, info, tab) {
    const siteKey = Core.siteKeyForUrl(
      info && (info.pageUrl || info.frameUrl) || tab && tab.url || ""
    );
    const imageKey = Core.ignoreKeyForUrl(image.url);
    if (!siteKey || !imageKey) {
      throw new Error("This media item cannot be ignored on this page.");
    }
    const area = tab && tab.incognito ? browser.storage.session : browser.storage.local;
    const storageKey = `${ignoreStoragePrefix(siteKey)}${imageKey}`;
    await area.set({ [storageKey]: Date.now() });
    const stored = await area.get(null);
    const sitePrefix = ignoreStoragePrefix(siteKey);
    const siteEntries = Object.entries(stored)
      .filter(([key]) => key.startsWith(sitePrefix))
      .sort((left, right) => (Number(left[1]) || 0) - (Number(right[1]) || 0));
    const siteOverflow = siteEntries
      .slice(0, Math.max(0, siteEntries.length - MAX_IGNORED_PER_SITE))
      .map(([key]) => key);
    if (siteOverflow.length) {
      await area.remove(siteOverflow);
      for (const key of siteOverflow) {
        delete stored[key];
      }
    }
    const allEntries = Object.entries(stored)
      .filter(([key]) => key.startsWith(IGNORE_STORAGE_PREFIX))
      .sort((left, right) => (Number(left[1]) || 0) - (Number(right[1]) || 0));
    const globalOverflow = allEntries
      .slice(0, Math.max(0, allEntries.length - MAX_IGNORED_RULES))
      .map(([key]) => key);
    if (globalOverflow.length) {
      await area.remove(globalOverflow);
    }
  }

  function defaultFolderForPage(info, tab) {
    let hostname = "page";
    try {
      hostname = new URL(info && info.pageUrl || tab && tab.url || "").hostname || hostname;
    } catch (_error) {
      // The fallback segment is safe for browser-owned or otherwise unusual pages.
    }
    return `${Core.DEFAULT_FOLDER}/${Core.sanitizePathSegment(hostname, "page")}`;
  }

  async function downloadContextImage(image, info, tab) {
    const stored = await browser.storage.local.get([
      "destinationFolder",
      "askForSingle",
      "filenameTemplate"
    ]);
    const storedFolder = Core.validateFolderPath(stored.destinationFolder);
    const folder = storedFolder.ok ? storedFolder.value : defaultFolderForPage(info, tab);
    let filename = preferredFilenameForMedia(image, 0);
    if (Templates && typeof Templates.render === "function") {
      const template = Templates.validate(stored.filenameTemplate || Templates.DEFAULT_TEMPLATE);
      if (template.ok) {
        filename = Templates.render(template.value, {
          filename,
          url: image.url,
          pageUrl: info && (info.pageUrl || info.frameUrl) || tab && tab.url || "",
          pageTitle: tab && tab.title || "",
          width: image.width,
          height: image.height,
          mediaType: image.mediaType,
          mimeType: image.mimeType,
          index: 1,
          date: Date.now()
        });
      }
    }
    const result = await enqueueDownloadBatch(validateBatch({
      type: "DOWNLOAD_BATCH",
      folder,
      saveAs: Boolean(stored.askForSingle),
      incognito: Boolean(tab && tab.incognito),
      pageTitle: tab && tab.title || "Media download",
      pageUrl: info && (info.pageUrl || info.frameUrl) || tab && tab.url || "",
      items: [{ url: image.url, filename, mediaType: image.mediaType }]
    }));
    if (!result.ok) {
      const firstError = result.errors && result.errors[0] && result.errors[0].error;
      throw new Error(firstError || "Firefox could not start this download.");
    }
  }

  async function handleImageMenuClick(info, tab) {
    let youtubePermissionPromise = Promise.resolve(true);
    if (
      info.menuItemId === MENU_IDS.download &&
      info && info.mediaType === "video" &&
      tab && isYouTubeVideoPageUrl(tab.url)
    ) {
      if (!browser.permissions || typeof browser.permissions.request !== "function") {
        throw new Error("Firefox cannot grant the YouTube access needed to refresh this video link.");
      }
      youtubePermissionPromise = browser.permissions.request({
        origins: ["https://www.youtube.com/*"]
      });
    }
    if (!await youtubePermissionPromise) {
      throw new Error("YouTube access was not granted, so no video was queued.");
    }
    const image = await resolveContextMedia(info, tab);
    if (info.menuItemId === MENU_IDS.download) {
      await downloadContextImage(image, info, tab);
    } else if (info.menuItemId === MENU_IDS.preview) {
      await openContextPreview(image, tab);
    } else if (info.menuItemId === MENU_IDS.ignore) {
      await storeContextIgnoreRule(image, info, tab);
    } else {
      return;
    }
    showActionFeedback(tab && tab.id, true);
  }

  function finishRetainedDownload(downloadId, state, error) {
    const retained = retainedObjectUrls.get(downloadId);
    if (!retained) {
      return;
    }
    retainedObjectUrls.delete(downloadId);
    if (retained.pollTimer !== null) {
      clearTimeout(retained.pollTimer);
    }
    URL.revokeObjectURL(retained.objectUrl);
    retained.resolve({
      state: state || "complete",
      error: error || ""
    });
  }

  browser.downloads.onChanged.addListener((change) => {
    if (
      change &&
      change.state &&
      ["complete", "interrupted"].includes(change.state.current)
    ) {
      finishRetainedDownload(
        change.id,
        change.state.current,
        change.error && change.error.current
      );
    }
    return handleQueuedDownloadChange(change).catch((error) => {
      console.error("AnyDownload could not update its download queue.", error);
    });
  });

  function decodeDataMediaUrl(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Malformed embedded media URL.");
    }
    const header = dataUrl.slice(5, commaIndex);
    const payload = dataUrl.slice(commaIndex + 1);
    const mimeType = (header.split(";")[0] || "application/octet-stream").toLowerCase();
    let bytes;

    if (/;base64(?:;|$)/i.test(header)) {
      const binary = atob(payload.replace(/\s/g, ""));
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }

    return { bytes, mimeType };
  }

  function dataUrlToObjectUrl(dataUrl) {
    const decoded = decodeDataMediaUrl(dataUrl);
    return URL.createObjectURL(new Blob([decoded.bytes], { type: decoded.mimeType }));
  }

  function retainObjectUrlUntilFinished(downloadId, objectUrl) {
    return new Promise((resolve) => {
      const retained = {
        objectUrl,
        resolve,
        startedAt: Date.now(),
        pollTimer: null
      };
      retainedObjectUrls.set(downloadId, retained);

      async function poll() {
        if (retainedObjectUrls.get(downloadId) !== retained) {
          return;
        }
        try {
          const matches = await browser.downloads.search({ id: downloadId });
          const item = matches[0];
          if (item && ["complete", "interrupted"].includes(item.state)) {
            finishRetainedDownload(downloadId, item.state, item.error);
            return;
          }
        } catch (_error) {
          // A later poll or downloads.onChanged can still observe completion.
        }
        if (Date.now() - retained.startedAt >= DOWNLOAD_RETENTION_MAX_MS) {
          finishRetainedDownload(
            downloadId,
            "interrupted",
            "AnyDownload stopped waiting for Firefox after 24 hours"
          );
          return;
        }
        retained.pollTimer = setTimeout(poll, DOWNLOAD_RETENTION_POLL_MS);
      }

      poll();
    });
  }

  function validateBatch(message) {
    if (!message || message.type !== "DOWNLOAD_BATCH") {
      throw new Error("Unsupported message.");
    }

    const folderResult = Core.validateFolderPath(message.folder);
    if (!folderResult.ok) {
      throw new Error(folderResult.error);
    }

    if (!Array.isArray(message.items) || message.items.length === 0) {
      throw new Error("Choose at least one media file.");
    }

    if (message.items.length > Core.MAX_BATCH_SIZE) {
      throw new Error(`A batch can contain at most ${Core.MAX_BATCH_SIZE} media files.`);
    }

    const items = [];
    const validationErrors = [];
    const usedNames = new Set();
    let totalUrlLength = 0;
    message.items.forEach((item, index) => {
      const validateMediaUrl = Core.validateMediaUrl || Core.validateDownloadUrl;
      const directUrlResult = validateMediaUrl(item && item.url);
      if (!directUrlResult.ok) {
        validationErrors.push({ index, error: `Media file ${index + 1}: ${directUrlResult.error}` });
        return;
      }
      const mediaType = item && item.mediaType === "video" ? "video" : "image";
      const providerUrl = youtubeQueueUrl(
        message.pageUrl,
        directUrlResult.value,
        mediaType
      );
      const queuedUrl = providerUrl || directUrlResult.value;
      if (totalUrlLength + queuedUrl.length > Core.MAX_BATCH_TOTAL_URL_LENGTH) {
        validationErrors.push({ index, error: `Media file ${index + 1}: the batch URL payload is too large.` });
        return;
      }
      totalUrlLength += queuedUrl.length;
      const fallbackName = (Core.filenameForMedia || Core.filenameForImage)(
        directUrlResult.value,
        index,
        mediaType
      );
      const suppliedName = typeof (item && item.filename) === "string"
        ? Core.sanitizeFilename(item.filename, fallbackName)
        : fallbackName;
      const filename = Core.uniquifyFilename(suppliedName, usedNames);
      items.push({ url: queuedUrl, filename, mediaType, originalIndex: index });
    });

    if (!items.length) {
      throw new Error(validationErrors[0] ? validationErrors[0].error : "No valid media URLs were supplied.");
    }

    return {
      folder: folderResult.value,
      items,
      saveAs: Boolean(message.saveAs) && message.items.length === 1 && items.length === 1,
      incognito: Boolean(message.incognito),
      label: String(message.pageTitle || "Download").trim().slice(0, 200) || "Download",
      source: String(message.pageUrl || "").slice(0, 500),
      total: message.items.length,
      validationErrors
    };
  }

  function validateArchive(message) {
    if (!message || message.type !== "DOWNLOAD_ARCHIVE") {
      throw new Error("Unsupported message.");
    }

    const folderResult = Core.validateFolderPath(message.folder);
    if (!folderResult.ok) {
      throw new Error(folderResult.error);
    }

    if (!Array.isArray(message.items) || message.items.length === 0) {
      throw new Error("Choose at least one image.");
    }

    if (message.items.length > MAX_ARCHIVE_ITEMS) {
      throw new Error(`An archive can contain at most ${MAX_ARCHIVE_ITEMS} images.`);
    }

    const items = [];
    const validationErrors = [];
    let totalUrlLength = 0;

    function archiveItemLooksLikeVideo(item) {
      if (!item || typeof item !== "object") {
        return false;
      }
      if (String(item.mediaType || "").toLowerCase() === "video") {
        return true;
      }
      const rawUrl = String(item.url || "");
      if (/^data:video\//i.test(rawUrl)) {
        return true;
      }
      const mimeType = String(item.mimeType || item.type || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (/^video\//.test(mimeType) || [
        "application/mp4",
        "application/ogg",
        "application/webm",
        "application/x-matroska"
      ].includes(mimeType)) {
        return true;
      }
      if (VIDEO_FILE_EXTENSION.test(String(item.filename || ""))) {
        return true;
      }
      try {
        const parsed = new URL(rawUrl);
        if (VIDEO_FILE_EXTENSION.test(parsed.pathname)) {
          return true;
        }
        const format = (parsed.searchParams.get("format") || parsed.searchParams.get("fm") || "")
          .toLowerCase()
          .replace(/^video\//, "");
        return VIDEO_FILE_FORMATS.has(format);
      } catch (_error) {
        return false;
      }
    }

    message.items.forEach((item, index) => {
      if (archiveItemLooksLikeVideo(item)) {
        validationErrors.push({ index, error: `Image ${index + 1}: ZIP archives support images only.` });
        return;
      }
      const urlResult = Core.validateDownloadUrl(item && item.url);
      if (!urlResult.ok) {
        validationErrors.push({ index, error: `Image ${index + 1}: ${urlResult.error}` });
        return;
      }
      if (totalUrlLength + urlResult.value.length > Core.MAX_BATCH_TOTAL_URL_LENGTH) {
        validationErrors.push({ index, error: `Image ${index + 1}: the archive URL payload is too large.` });
        return;
      }
      if (item.filename !== undefined && typeof item.filename !== "string") {
        validationErrors.push({ index, error: `Image ${index + 1}: the archive filename is invalid.` });
        return;
      }
      totalUrlLength += urlResult.value.length;
      const fallbackFilename = Core.filenameForImage(urlResult.value, index);
      items.push({
        url: urlResult.value,
        filename: Core.sanitizeFilename(item.filename || fallbackFilename, fallbackFilename),
        originalIndex: index
      });
    });

    if (!items.length) {
      throw new Error(validationErrors[0] ? validationErrors[0].error : "No valid image URLs were supplied.");
    }

    return {
      folder: folderResult.value,
      items,
      incognito: Boolean(message.incognito),
      total: message.items.length,
      validationErrors
    };
  }

  function contentLengthForResponse(response) {
    if (!response || !response.headers || typeof response.headers.get !== "function") {
      return 0;
    }
    const value = Number(response.headers.get("content-length"));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async function readResponseBytes(response, declaredLength) {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      let bytes = declaredLength ? new Uint8Array(declaredLength) : null;
      let chunks = bytes ? null : [];
      let size = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        const chunk = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value);
        const nextSize = size + chunk.byteLength;
        if (nextSize > MAX_ARCHIVE_ENTRY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Image is larger than the 64 MiB per-file archive limit.");
        }
        if (bytes && nextSize <= bytes.byteLength) {
          bytes.set(chunk, size);
        } else {
          if (bytes) {
            chunks = [bytes.subarray(0, size)];
            bytes = null;
          }
          chunks.push(chunk);
        }
        size = nextSize;
      }
      if (bytes) {
        return size === bytes.byteLength ? bytes : bytes.slice(0, size);
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error("Image is larger than the 64 MiB per-file archive limit.");
    }
    return bytes;
  }

  function contentTypeForResponse(response) {
    if (!response || !response.headers || typeof response.headers.get !== "function") {
      return "";
    }
    return String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
  }

  async function fetchArchiveBytes(url) {
    if (url.startsWith("data:")) {
      return decodeDataMediaUrl(url).bytes;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_ARCHIVE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response || !response.ok) {
        const status = response && Number(response.status) || 0;
        const statusText = response && String(response.statusText || "").trim();
        throw new Error(status
          ? `Image request failed with HTTP ${status}${statusText ? ` ${statusText}` : ""}.`
          : "Image request failed.");
      }

      const contentType = contentTypeForResponse(response);
      if (contentType && !contentType.startsWith("image/") && ![
        "application/octet-stream",
        "binary/octet-stream"
      ].includes(contentType)) {
        throw new Error(`Image request returned ${contentType} instead of an image.`);
      }
      const declaredLength = contentLengthForResponse(response);
      if (declaredLength > MAX_ARCHIVE_ENTRY_BYTES) {
        throw new Error("Image is larger than the 64 MiB per-file archive limit.");
      }
      return await readResponseBytes(response, declaredLength);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Image request timed out after 2 minutes.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function archiveFilenameForFolder(folder) {
    const lastSegment = folder.split("/").filter(Boolean).pop() || "images";
    const suffix = ".zip";
    const maximumBasenameLength = 100 - suffix.length;
    let basename = Core.sanitizePathSegment(
      lastSegment.replace(/\.zip$/i, ""),
      "images"
    ).slice(0, maximumBasenameLength);
    if (/[\uD800-\uDBFF]$/.test(basename)) {
      basename = basename.slice(0, -1);
    }
    basename = basename.replace(/[. ]+$/g, "") || "images";
    return Core.sanitizeFilename(`${basename}${suffix}`, "images.zip");
  }

  function archiveErrorReport(failures) {
    const lines = [
      "AnyDownload could not archive the following images:",
      ""
    ];
    failures.forEach((failure) => {
      const number = Number(failure.index) + 1;
      const name = failure.filename ? ` (${failure.filename})` : "";
      lines.push(`Image ${number}${name}: ${failure.error}`);
    });
    return new TextEncoder().encode(`${lines.join("\n")}\n`);
  }

  async function buildArchive(batch) {
    if (!Archive || typeof Archive.createStoredZip !== "function") {
      throw new Error("The archive builder is unavailable.");
    }

    const usedNames = new Set();
    const candidates = batch.items.map((item) => {
      const fallbackName = Core.filenameForImage(item.url, item.originalIndex);
      const baseName = Core.sanitizeFilename(item.filename || fallbackName, fallbackName);
      return {
        ...item,
        filename: Core.uniquifyFilename(baseName, usedNames)
      };
    });
    const failures = batch.validationErrors.slice();
    const successfulEntries = new Array(candidates.length);
    let totalBytes = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < candidates.length) {
        const candidateIndex = cursor;
        const candidate = candidates[candidateIndex];
        cursor += 1;
        try {
          const bytes = await fetchArchiveBytes(candidate.url);
          if (totalBytes + bytes.byteLength > MAX_ARCHIVE_TOTAL_BYTES) {
            throw new Error("Adding this image would exceed the 256 MiB archive limit.");
          }
          totalBytes += bytes.byteLength;
          successfulEntries[candidateIndex] = { name: candidate.filename, data: bytes };
        } catch (error) {
          failures.push({
            index: candidate.originalIndex,
            filename: candidate.filename,
            error: error && error.message ? error.message : String(error)
          });
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(MAX_ARCHIVE_FETCH_CONCURRENCY, candidates.length) },
      () => worker()
    );
    await Promise.all(workers);
    failures.sort((left, right) => (Number(left.index) || 0) - (Number(right.index) || 0));

    const archiveImageEntries = successfulEntries.filter(Boolean);
    if (!archiveImageEntries.length) {
      const firstError = failures[0] && failures[0].error;
      return {
        ok: false,
        total: batch.total,
        archived: 0,
        failed: batch.total,
        folder: batch.folder,
        filename: archiveFilenameForFolder(batch.folder),
        error: firstError || "None of the selected images could be archived.",
        errors: failures
      };
    }

    const zipEntries = archiveImageEntries.slice();
    if (failures.length) {
      zipEntries.push({
        name: "anydownload-errors.txt",
        data: archiveErrorReport(failures)
      });
    }
    const zip = Archive.createStoredZip(zipEntries, { date: new Date() });
    if (!zip || !Array.isArray(zip.parts) || !Number.isFinite(zip.size) || zip.entryCount !== zipEntries.length) {
      throw new Error("The archive builder returned an invalid ZIP file.");
    }

    const filename = archiveFilenameForFolder(batch.folder);
    const targetPath = Core.buildDownloadPath(batch.folder, filename);
    const archivedCount = archiveImageEntries.length;
    const archiveBlob = new Blob(zip.parts, { type: "application/zip" });
    successfulEntries.fill(null);
    archiveImageEntries.length = 0;
    zipEntries.length = 0;
    zip.parts.length = 0;
    let objectUrl = URL.createObjectURL(archiveBlob);
    try {
      const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename: targetPath,
        conflictAction: "uniquify",
        saveAs: false,
        incognito: batch.incognito
      });
      if (typeof downloadId !== "number") {
        throw new Error("Firefox did not start the archive download.");
      }
      const retainedUrl = objectUrl;
      objectUrl = "";
      const terminal = await retainObjectUrlUntilFinished(downloadId, retainedUrl);
      if (terminal && terminal.state === "interrupted") {
        throw new Error(
          `The ZIP download was interrupted${terminal.error ? ` (${terminal.error})` : ""}.`
        );
      }
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }

    return {
      ok: true,
      total: batch.total,
      archived: archivedCount,
      failed: batch.total - archivedCount,
      folder: batch.folder,
      filename,
      errors: failures
    };
  }

  async function startArchive(batch) {
    if (archiveInProgress) {
      throw new Error("Another ZIP archive is already being built. Wait for it to finish and try again.");
    }
    archiveInProgress = true;
    try {
      return await buildArchive(batch);
    } finally {
      archiveInProgress = false;
    }
  }

  function archiveFailureResponse(message, error) {
    const total = Array.isArray(message && message.items) ? message.items.length : 0;
    const folderResult = Core.validateFolderPath(message && message.folder);
    const folder = folderResult.ok ? folderResult.value : "";
    return {
      ok: false,
      total,
      archived: 0,
      failed: total,
      folder,
      filename: folder ? archiveFilenameForFolder(folder) : "",
      error: error && error.message ? error.message : String(error),
      errors: error && Array.isArray(error.errors) ? error.errors : []
    };
  }

  function queueContext(incognito) {
    const key = incognito ? "private" : "normal";
    if (!downloadQueueContexts.has(key)) {
      downloadQueueContexts.set(key, {
        incognito: Boolean(incognito),
        area: incognito ? browser.storage.session : browser.storage.local,
        state: null,
        dirty: false,
        operation: Promise.resolve()
      });
    }
    return downloadQueueContexts.get(key);
  }

  function queueOperation(incognito, callback) {
    const context = queueContext(incognito);
    const result = context.operation
      .catch(() => undefined)
      .then(async () => {
        await loadQueueLocked(context);
        return callback(context);
      });
    context.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persistQueueLocked(context) {
    context.dirty = true;
    await context.area.set({ [QUEUE_STORAGE_KEY]: context.state });
    context.dirty = false;
  }

  function queueTasksWithDownloadIds(state) {
    return state.jobs.flatMap((job) => job.tasks)
      .filter((task) => Number.isInteger(task.downloadId) && (
        !["complete", "interrupted", "cancelled"].includes(task.status)
        || task.needsReconciliation === true
      ));
  }

  function durableQueueTaskSignature(task) {
    return JSON.stringify([
      task.status,
      task.downloadId,
      task.attempt,
      task.recordedAttempt,
      task.needsReconciliation === true,
      task.bytesReceived,
      task.totalBytes,
      task.filename,
      task.error,
      task.completedAt
    ]);
  }

  function withoutLocalFilename(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return snapshot;
    }
    const safe = { ...snapshot };
    // Firefox exposes an absolute local path here. Keep only its sanitized
    // basename (which may include Firefox's conflict suffix), never the path.
    const localFilename = typeof safe.filename === "string" ? safe.filename : "";
    delete safe.filename;
    const leaf = localFilename.split(/[\\/]/).pop();
    if (leaf) {
      safe.filename = Core.sanitizeFilename(leaf, "");
    }
    return safe;
  }

  function withoutLocalFilenameChange(change) {
    if (!change || typeof change !== "object") {
      return change;
    }
    const safe = { ...change };
    const filenameDelta = safe.filename;
    const localFilename = filenameDelta && typeof filenameDelta === "object"
      ? filenameDelta.current
      : filenameDelta;
    delete safe.filename;
    const leaf = typeof localFilename === "string"
      ? localFilename.split(/[\\/]/).pop()
      : "";
    if (leaf) {
      safe.filename = { current: Core.sanitizeFilename(leaf, "") };
    }
    return safe;
  }

  async function reconcileQueueLocked(context, markMissing) {
    const tasks = queueTasksWithDownloadIds(context.state);
    if (!tasks.length) {
      return false;
    }
    const snapshots = [];
    const missingTasks = [];
    const taskSignatures = new Map(
      tasks.map((task) => [task.id, durableQueueTaskSignature(task)])
    );
    let durableChange = false;
    for (const task of tasks) {
      try {
        const matches = await browser.downloads.search({ id: task.downloadId });
        if (matches && matches[0]) {
          const snapshot = withoutLocalFilename(matches[0]);
          if (
            task.needsReconciliation === true
            && ["complete", "interrupted", "cancelled"].includes(task.status)
            && snapshot.state !== task.status
          ) {
            continue;
          }
          snapshots.push(snapshot);
        } else if (markMissing) {
          missingTasks.push(task);
        }
      } catch (_error) {
        // Transient API failures keep the task intact so it can be reconciled
        // on a later wake instead of being mistaken for a removed download.
      }
    }
    context.state = DownloadQueue.applyDownloadSnapshots(context.state, snapshots);
    for (const job of context.state.jobs) {
      for (const task of job.tasks) {
        const previousSignature = taskSignatures.get(task.id);
        if (
          previousSignature !== undefined
          && previousSignature !== durableQueueTaskSignature(task)
        ) {
          durableChange = true;
        }
      }
    }
    for (const task of missingTasks) {
      if (["complete", "interrupted", "cancelled"].includes(task.status)) {
        context.state = DownloadQueue.applyDownloadSnapshot(context.state, {
          id: task.downloadId,
          state: task.status
        });
      } else {
        context.state = DownloadQueue.interruptTask(
          context.state,
          task.id,
          "Download no longer exists in Firefox history."
        );
      }
      durableChange = true;
    }
    return durableChange;
  }

  async function loadQueueLocked(context) {
    if (context.state) {
      return;
    }
    if (!DownloadQueue) {
      throw new Error("The AnyDownload queue engine is unavailable.");
    }
    const stored = await context.area.get(QUEUE_STORAGE_KEY);
    context.state = DownloadQueue.hydrate(stored && stored[QUEUE_STORAGE_KEY], {
      recoverInFlight: true
    });
    await reconcileQueueLocked(context, true);
    await persistQueueLocked(context);
  }

  function findQueueTask(state, taskId) {
    for (const job of state.jobs) {
      const task = job.tasks.find((candidate) => candidate.id === taskId);
      if (task) {
        return { job, task };
      }
    }
    return null;
  }

  function queueTaskIds(state, targetType, id) {
    if (targetType === "task") {
      return findQueueTask(state, id) ? [id] : [];
    }
    if (targetType === "job") {
      const job = state.jobs.find((candidate) => candidate.id === id);
      return job ? job.tasks.map((task) => task.id) : [];
    }
    if (targetType === "all") {
      return state.jobs.flatMap((job) => job.tasks.map((task) => task.id));
    }
    return [];
  }

  async function pumpQueueLocked(context, hasUnpersistedChanges) {
    // A failed start frees a slot immediately. Loop so another queued item can
    // use it without waiting for a later Firefox event.
    if (hasUnpersistedChanges === true) {
      context.dirty = true;
    }
    while (true) {
      const pausedCount = context.state.jobs.reduce(
        (total, job) => total + job.tasks.filter((task) =>
          task.status === "paused" && Number.isInteger(task.downloadId)
        ).length,
        0
      );
      // A paused Firefox download can resume at any time. Keep its slot
      // reserved so resuming cannot exceed the queue's concurrency limit.
      if (pausedCount >= QUEUE_CONCURRENCY) {
        if (context.dirty) {
          await persistQueueLocked(context);
        }
        return;
      }
      const stateBeforeClaim = context.state;
      const dirtyBeforeClaim = context.dirty;
      const claimed = DownloadQueue.claimNextTasks(context.state, {
        concurrency: QUEUE_CONCURRENCY - pausedCount
      });
      context.state = claimed.state;
      if (!claimed.tasks.length) {
        if (context.dirty) {
          await persistQueueLocked(context);
        }
        return;
      }
      try {
        await persistQueueLocked(context);
      } catch (error) {
        // No native download has started yet. Restore the queued state so the
        // cached background context can retry instead of stranding unbound
        // tasks as "starting" after a storage failure.
        context.state = stateBeforeClaim;
        context.dirty = dirtyBeforeClaim;
        throw error;
      }
      let failedStarts = 0;
      for (const task of claimed.tasks) {
        let objectUrl = "";
        let downloadId = null;
        try {
          const resolvedUrl = await resolveQueueMediaUrl(task);
          const downloadUrl = resolvedUrl.startsWith("data:")
            ? (objectUrl = dataUrlToObjectUrl(resolvedUrl))
            : resolvedUrl;
          const downloadOptions = {
            url: downloadUrl,
            filename: Core.buildDownloadPath(task.folder, task.filename),
            conflictAction: "uniquify",
            saveAs: Boolean(task.saveAs),
            incognito: context.incognito
          };
          const headers = downloadHeadersForSource(task.source);
          if (headers.length) {
            downloadOptions.headers = headers;
          }
          downloadId = await browser.downloads.download(downloadOptions);
          if (!Number.isInteger(downloadId)) {
            throw new Error("Firefox did not return a download identifier.");
          }
        } catch (error) {
          failedStarts += 1;
          context.state = DownloadQueue.interruptTask(
            context.state,
            task.id,
            error && error.message ? error.message : String(error)
          );
          context.dirty = true;
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
          }
          continue;
        }

        // Firefox has accepted this download. Retain its object URL before any
        // fallible bookkeeping so a storage error cannot revoke a live source.
        if (objectUrl) {
          retainObjectUrlUntilFinished(downloadId, objectUrl).catch(() => undefined);
          objectUrl = "";
        }
        context.state = DownloadQueue.bindDownload(context.state, task.id, downloadId);
        try {
          await persistQueueLocked(context);
        } catch (error) {
          // Keep the accepted native download bound in memory, but release any
          // later claimed tasks that Firefox has not started yet. The dirty
          // flag makes the next queue operation retry this failed write.
          context.state = DownloadQueue.hydrate(context.state, {
            recoverInFlight: true
          });
          context.dirty = true;
          throw error;
        }
      }
      if (!failedStarts) {
        return;
      }
    }
  }

  function queueDashboardSnapshot(state) {
    const summary = DownloadQueue.progressSummary(state) || {};
    const mapSummary = (value) => ({
      total: Number(value && value.total) || 0,
      queued: Number(value && value.queued) || 0,
      starting: Number(value && value.starting) || 0,
      active: (Number(value && value.starting) || 0) + (Number(value && value.in_progress) || 0),
      paused: Number(value && value.paused) || 0,
      complete: Number(value && value.complete) || 0,
      failed: Number(value && value.interrupted) || 0,
      cancelled: Number(value && value.cancelled) || 0,
      pending: (Number(value && value.queued) || 0) +
        (Number(value && value.starting) || 0) +
        (Number(value && value.in_progress) || 0) +
        (Number(value && value.paused) || 0)
    });
    const totals = mapSummary(summary);
    const stats = state.stats || {};
    const lifetime = stats.lifetime || {};
    const storedToday = stats.today || {};
    const currentDay = DownloadQueue.dayKey();
    const today = storedToday.date === currentDay ? storedToday : {};
    const currentJobs = state.jobs
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((job) => {
        const counts = mapSummary(DownloadQueue.progressSummary(state, job.id));
        return {
          id: job.id,
          label: job.label,
          folder: job.folder,
          source: job.source,
          status: job.status,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          finishedAt: job.finishedAt,
          historyOnly: false,
          counts,
          tasks: job.tasks.map((task) => ({
            id: task.id,
            filename: task.filename,
            status: task.status,
            downloadId: task.downloadId,
            bytesReceived: task.bytesReceived,
            totalBytes: task.totalBytes,
            error: task.error,
            attempt: task.attempt
          }))
        };
      });
    const currentJobIds = new Set(currentJobs.map((job) => job.id));
    const historicalJobs = (Array.isArray(state.history) ? state.history : [])
      .filter((item) => !currentJobIds.has(item.jobId))
      .map((item) => ({
        id: item.jobId,
        label: item.label,
        folder: item.folder,
        source: "",
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.finishedAt,
        finishedAt: item.finishedAt,
        historyOnly: true,
        counts: {
          total: item.total,
          queued: 0,
          starting: 0,
          active: 0,
          paused: 0,
          complete: item.completed,
          failed: item.interrupted,
          cancelled: item.cancelled,
          pending: 0
        },
        tasks: []
      }));
    return {
      summary: totals,
      stats: {
        lifetime: {
          enqueued: Number(lifetime.enqueued) || 0,
          completed: Number(lifetime.completed) || 0,
          failed: Number(lifetime.interrupted) || 0,
          cancelled: Number(lifetime.cancelled) || 0,
          bytes: Number(lifetime.bytesDownloaded) || 0
        },
        today: {
          date: currentDay,
          enqueued: Number(today.enqueued) || 0,
          completed: Number(today.completed) || 0,
          failed: Number(today.interrupted) || 0,
          cancelled: Number(today.cancelled) || 0,
          bytes: Number(today.bytesDownloaded) || 0
        }
      },
      jobs: currentJobs.concat(historicalJobs)
        .sort((left, right) => right.createdAt - left.createdAt)
    };
  }

  function queueHasRoomFor(state, items) {
    const taskCount = state.jobs.reduce((total, job) => total + job.tasks.length, 0);
    const urlLength = state.jobs.reduce(
      (total, job) => total + job.tasks.reduce((sum, task) => sum + task.url.length, 0),
      0
    );
    const incomingUrlLength = items.reduce((total, item) => total + item.url.length, 0);
    return state.jobs.length < DownloadQueue.MAX_STORED_JOBS &&
      taskCount + items.length <= DownloadQueue.MAX_STORED_TASKS &&
      urlLength + incomingUrlLength <= DownloadQueue.MAX_BATCH_TOTAL_URL_LENGTH;
  }

  function makeQueueRoom(state, items) {
    if (queueHasRoomFor(state, items)) {
      return state;
    }
    let nextState = DownloadQueue.clearCompleted(state).state;
    if (queueHasRoomFor(nextState, items)) {
      return nextState;
    }
    const terminalJobs = nextState.jobs
      .filter((job) => ["complete", "interrupted", "cancelled"].includes(job.status) &&
        !job.tasks.some((task) => task.needsReconciliation))
      .sort((left, right) => left.finishedAt - right.finishedAt);
    const removedIds = new Set();
    for (const job of terminalJobs) {
      removedIds.add(job.id);
      const candidate = DownloadQueue.hydrate({
        ...nextState,
        jobs: nextState.jobs.filter((entry) => !removedIds.has(entry.id))
      }, { recoverInFlight: false });
      if (queueHasRoomFor(candidate, items)) {
        return candidate;
      }
    }
    return nextState;
  }

  async function enqueueDownloadBatch(batch) {
    if (!DownloadQueue) {
      return startBatch(batch);
    }
    return queueOperation(batch.incognito, async (context) => {
      const stateBeforeEnqueue = context.state;
      const dirtyBeforeEnqueue = context.dirty;
      context.state = makeQueueRoom(context.state, batch.items);
      const result = DownloadQueue.enqueueBatch(context.state, batch.items, {
        folder: batch.folder,
        label: batch.label,
        source: batch.source,
        saveAs: batch.saveAs
      });
      context.state = result.state;
      try {
        // Queue acceptance is its own transaction. Never report acceptance
        // until the queued state itself is durable.
        await persistQueueLocked(context);
      } catch (error) {
        context.state = stateBeforeEnqueue;
        context.dirty = dirtyBeforeEnqueue;
        throw error;
      }
      let warning = "";
      try {
        await pumpQueueLocked(context);
      } catch (error) {
        // The batch is already durably accepted. Keep any dirty scheduler
        // bookkeeping for the next operation instead of telling the caller
        // that an accepted queue submission failed.
        warning = error && error.message ? error.message : String(error);
      }
      const errors = batch.validationErrors
        .concat(result.rejected.map((failure) => ({
          index: failure.index,
          error: failure.error
        })))
        .slice(0, 10);
      return {
        ok: result.accepted > 0,
        total: batch.total,
        queued: result.accepted,
        failed: batch.total - result.accepted,
        folder: batch.folder,
        jobId: result.jobId,
        errors,
        warning,
        error: result.accepted ? "" : errors[0] && errors[0].error || "The download queue is full."
      };
    });
  }

  async function updateQueueForDownload(incognito, change) {
    return queueOperation(incognito, async (context) => {
      const downloadId = change && change.id;
      const found = context.state.jobs.some((job) =>
        job.tasks.some((task) => task.downloadId === downloadId)
      );
      if (!found) {
        return false;
      }
      let appliedSnapshot = false;
      if (change.state && ["complete", "interrupted"].includes(change.state.current)) {
        try {
          const matches = await browser.downloads.search({ id: downloadId });
          if (matches && matches[0] && ["complete", "interrupted"].includes(matches[0].state)) {
            context.state = DownloadQueue.applyDownloadSnapshot(
              context.state,
              withoutLocalFilename(matches[0])
            );
            appliedSnapshot = true;
          }
        } catch (_error) {
          // The onChanged delta below still records a terminal result.
        }
      }
      if (!appliedSnapshot) {
        context.state = DownloadQueue.applyDownloadChange(
          context.state,
          downloadId,
          withoutLocalFilenameChange(change)
        );
      }
      await pumpQueueLocked(context, true);
      return true;
    });
  }

  async function handleQueuedDownloadChange(change) {
    if (!DownloadQueue || !change || !Number.isInteger(change.id)) {
      return;
    }
    if (await updateQueueForDownload(false, change)) {
      return;
    }
    await updateQueueForDownload(true, change);
  }

  async function downloadQueueAction(message) {
    const action = String(message.action || "");
    const targetType = String(message.targetType || "");
    const id = String(message.id || "");
    if (!["pause", "resume", "cancel", "retry", "clear_completed"].includes(action)) {
      throw new Error("Unknown queue action.");
    }
    if (!["task", "job", "all"].includes(targetType)) {
      throw new Error("Unknown queue target.");
    }
    return queueOperation(Boolean(message.incognito), async (context) => {
      const controlErrors = [];
      if (action === "clear_completed") {
        context.state = DownloadQueue.clearCompleted(context.state).state;
      } else if (action === "retry") {
        if (targetType === "task") {
          context.state = DownloadQueue.retryTask(context.state, id, {
            includeCancelled: true
          }).state;
        } else {
          context.state = DownloadQueue.retryFailures(context.state, {
            jobId: targetType === "job" ? id : "",
            includeCancelled: false
          }).state;
        }
      } else {
        const taskIds = queueTaskIds(context.state, targetType, id);
        const tasksById = new Map();
        for (const job of context.state.jobs) {
          for (const task of job.tasks) {
            tasksById.set(task.id, { job, task });
          }
        }
        const updatedTaskIds = [];
        for (const taskId of taskIds) {
          const found = tasksById.get(taskId);
          if (!found) {
            continue;
          }
          const task = found.task;
          if (action === "pause" && ["queued", "starting", "in_progress"].includes(task.status)) {
            if (Number.isInteger(task.downloadId)) {
              if (typeof browser.downloads.pause !== "function") {
                controlErrors.push({
                  taskId,
                  error: "Firefox cannot pause this download because the pause API is unavailable."
                });
                continue;
              }
              try {
                await browser.downloads.pause(task.downloadId);
              } catch (error) {
                controlErrors.push({
                  taskId,
                  error: `Firefox could not pause this download. (${error && error.message ? error.message : error})`
                });
                continue;
              }
            }
            updatedTaskIds.push(taskId);
          } else if (action === "resume" && task.status === "paused") {
            if (Number.isInteger(task.downloadId)) {
              if (typeof browser.downloads.resume !== "function") {
                controlErrors.push({
                  taskId,
                  error: "Firefox cannot resume this download because the resume API is unavailable."
                });
                continue;
              }
              try {
                await browser.downloads.resume(task.downloadId);
              } catch (error) {
                controlErrors.push({
                  taskId,
                  error: `Firefox could not resume this download. (${error && error.message ? error.message : error})`
                });
                continue;
              }
            }
            updatedTaskIds.push(taskId);
          } else if (action === "cancel" && ![
            "complete",
            "interrupted",
            "cancelled"
          ].includes(task.status)) {
            if (Number.isInteger(task.downloadId)) {
              if (typeof browser.downloads.cancel !== "function") {
                controlErrors.push({
                  taskId,
                  error: "Firefox cannot cancel this download because the cancel API is unavailable."
                });
                continue;
              }
              try {
                await browser.downloads.cancel(task.downloadId);
              } catch (error) {
                controlErrors.push({
                  taskId,
                  error: `Firefox could not cancel this download. (${error && error.message ? error.message : error})`
                });
                continue;
              }
            }
            updatedTaskIds.push(taskId);
          }
        }
        if (action === "pause") {
          context.state = DownloadQueue.setTasksPaused(
            context.state,
            updatedTaskIds,
            true
          ).state;
        } else if (action === "resume") {
          context.state = DownloadQueue.setTasksPaused(
            context.state,
            updatedTaskIds,
            false
          ).state;
        } else if (action === "cancel") {
          context.state = DownloadQueue.cancelTasks(context.state, updatedTaskIds, {
            reason: "Cancelled by user"
          }).state;
        }
      }
      await pumpQueueLocked(context, true);
      return {
        ok: controlErrors.length === 0,
        snapshot: queueDashboardSnapshot(context.state),
        error: controlErrors[0] ? controlErrors[0].error : "",
        errors: controlErrors.slice(0, 10)
      };
    });
  }

  async function getDownloadDashboard(incognito) {
    return queueOperation(Boolean(incognito), async (context) => {
      const reconciled = await reconcileQueueLocked(context, true);
      await pumpQueueLocked(context, reconciled);
      return { ok: true, snapshot: queueDashboardSnapshot(context.state) };
    });
  }

  function resumeStoredQueues() {
    if (!DownloadQueue) {
      return Promise.resolve();
    }
    return Promise.all([false, true].map((incognito) =>
      queueOperation(incognito, async (context) => {
        await pumpQueueLocked(context);
      }).catch((error) => {
        console.error("AnyDownload could not resume its saved queue.", error);
      })
    )).then(() => undefined);
  }

  async function startBatch(batch) {
    const usedNames = new Set();
    const entries = batch.items.map((item, index) => {
      const baseName = item.filename || Core.filenameForImage(item.url, index);
      const filename = Core.uniquifyFilename(baseName, usedNames);
      return {
        url: item.url,
        filename,
        source: batch.source,
        targetPath: Core.buildDownloadPath(batch.folder, filename)
      };
    });
    const failures = batch.validationErrors.slice();
    const retentionPromises = [];
    let started = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < entries.length) {
        const index = cursor;
        cursor += 1;
        const entry = entries[index];
        let objectUrl = "";
        try {
          const resolvedUrl = await resolveQueueMediaUrl(entry);
          const downloadUrl = resolvedUrl.startsWith("data:")
            ? (objectUrl = dataUrlToObjectUrl(resolvedUrl))
            : resolvedUrl;
          const downloadOptions = {
            url: downloadUrl,
            filename: entry.targetPath,
            conflictAction: "uniquify",
            saveAs: batch.saveAs,
            incognito: batch.incognito
          };
          const headers = downloadHeadersForSource(entry.source);
          if (headers.length) {
            downloadOptions.headers = headers;
          }
          const downloadId = await browser.downloads.download(downloadOptions);
          if (typeof downloadId === "number") {
            started += 1;
            if (objectUrl) {
              retentionPromises.push(retainObjectUrlUntilFinished(downloadId, objectUrl));
              objectUrl = "";
            }
          }
        } catch (error) {
          failures.push({
            index: batch.items[index].originalIndex,
            filename: entry.filename,
            error: error && error.message ? error.message : String(error)
          });
        } finally {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
          }
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, entries.length) },
      () => worker()
    );
    await Promise.all(workers);
    await Promise.all(retentionPromises);

    return {
      ok: started > 0,
      total: batch.total,
      started,
      failed: batch.total - started,
      folder: batch.folder,
      errors: failures.slice(0, 10)
    };
  }

  browser.runtime.onInstalled.addListener(() =>
    rebuildContextMenus().catch((error) => {
      console.error("AnyDownload could not rebuild its media context menu.", error);
    }).finally(resumeStoredQueues)
  );

  if (browser.runtime.onStartup && typeof browser.runtime.onStartup.addListener === "function") {
    browser.runtime.onStartup.addListener(resumeStoredQueues);
  }

  if (browser.menus && browser.menus.onClicked) {
    browser.menus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === MENU_IDS.open) {
        return openResizableImageWindow(tab).then(() => {
          showActionFeedback(tab && tab.id, true);
        }).catch((error) => {
          console.error("AnyDownload could not open its media window.", error);
          showActionFeedback(tab && tab.id, false);
        });
      }
      if (![MENU_IDS.download, MENU_IDS.preview, MENU_IDS.ignore].includes(info.menuItemId)) {
        return undefined;
      }
      return handleImageMenuClick(info, tab).catch((error) => {
        console.error("AnyDownload media action failed.", error);
        showActionFeedback(tab && tab.id, false);
      });
    });
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message) {
      return undefined;
    }

    if (message.type === "OPEN_MANAGER_WINDOW") {
      if (!Number.isInteger(message.sourceTabId) || message.sourceTabId < 0) {
        return Promise.resolve({
          ok: false,
          error: "The source tab identifier is invalid."
        });
      }
      return browser.tabs.get(message.sourceTabId)
        .then((tab) => openResizableImageWindow(tab, {
          liveCapture: Boolean(message.liveCapture)
        }))
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => ({
          ok: false,
          error: error && error.message ? error.message : String(error)
        }));
    }

    if (message.type === "DOWNLOAD_ARCHIVE") {
      try {
        return startArchive(validateArchive(message)).catch((error) =>
          archiveFailureResponse(message, error)
        );
      } catch (error) {
        return Promise.resolve(archiveFailureResponse(message, error));
      }
    }

    if (message.type === "GET_DOWNLOAD_DASHBOARD") {
      return getDownloadDashboard(Boolean(message.incognito)).catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : String(error)
      }));
    }

    if (message.type === "DOWNLOAD_QUEUE_ACTION") {
      return downloadQueueAction(message).catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : String(error)
      }));
    }

    if (message.type !== "DOWNLOAD_BATCH") {
      return undefined;
    }

    try {
      return enqueueDownloadBatch(validateBatch(message));
    } catch (error) {
      return Promise.resolve({
        ok: false,
        total: 0,
        queued: 0,
        failed: 0,
        error: error && error.message ? error.message : String(error),
        errors: []
      });
    }
  });

  // Firefox can recreate a non-persistent background context without firing
  // runtime.onStartup. Resume persisted work on every evaluation so an
  // unbound task recovered from "starting" cannot remain queued indefinitely.
  resumeStoredQueues().catch((error) => {
    console.error("AnyDownload could not resume its saved queue.", error);
  });
})();
