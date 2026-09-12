(function initializeDownloadBackground() {
  "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const collectImagesFromPage = globalThis.ImageDownloaderCollector;
  const FapFolder = globalThis.AnyDownloadFapFolder;
  const collectFapFolderMediaFromPage = globalThis.AnyDownloadFapFolderCollector ||
    (FapFolder && FapFolder.collectFromPage);
  const Instagram = globalThis.ImageDownloaderInstagram;
  const collectInstagramMediaFromPage = Instagram && Instagram.collectFromPage;
  const YouTube = globalThis.AnyDownloadYouTube;
  const collectYouTubeMediaFromPage = globalThis.AnyDownloadYouTubeCollector ||
    (YouTube && YouTube.collectYouTubeMediaFromPage);
  const Archive = globalThis.ImageDownloaderArchive;
  const Filters = globalThis.ImageDownloaderFilters;
  const Templates = globalThis.ImageDownloaderTemplates;
  const Tracker = globalThis.AnyDownloadTracker;
  const DownloadLedger = globalThis.AnyDownloadLedger;
  const Gallery = globalThis.AnyDownloadGallery;
  const DownloadQueue = globalThis.ImageDownloaderDownloadQueue;
  const MAX_CONCURRENCY = 5;
  const QUEUE_CONCURRENCY = 3;
  const QUEUE_RECONCILE_CONCURRENCY = 8;
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
  const trackerRuns = new Map();
  let trackerMutationQueue = Promise.resolve();
  let galleryMutationQueue = Promise.resolve();
  let archiveInProgress = false;
  let cloudSync = null;

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

  function managerWindowUrl(sourceTabId) {
    const launch = encodeURIComponent(createPreviewId());
    return browser.runtime.getURL(
      `popup/popup.html?sourceTabId=${encodeURIComponent(String(sourceTabId))}&launch=${launch}`
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

  function openResizableImageWindow(tab, collectGallery) {
    if (!tab || !Number.isInteger(tab.id)) {
      return Promise.reject(new Error("Firefox did not identify the source tab."));
    }

    const incognito = Boolean(tab.incognito);
    const storageKey = managerWindowStorageKey(incognito);
    const previous = managerWindowQueues.get(storageKey) || Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const url = managerWindowUrl(tab.id) + (collectGallery ? `&collect=1&pages=${collectGallery}` : "");
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
      FapFolder &&
      typeof FapFolder.isSupportedUrl === "function" &&
      typeof collectFapFolderMediaFromPage === "function" &&
      FapFolder.isSupportedUrl(tab.url)
    ) {
      try {
        const fapFolderResults = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: collectFapFolderMediaFromPage,
          args: [{
            maxItems: Core.MAX_BATCH_SIZE,
            maxPosts: 64,
            maxConcurrency: 3,
            maxDocumentBytes: 2000000,
            maxTotalDocumentBytes: 16000000,
            maxPayloadLength: Core.MAX_BATCH_TOTAL_URL_LENGTH,
            requestTimeoutMs: 8000
          }]
        });
        const fapFolderScan = fapFolderResults && fapFolderResults[0] &&
          fapFolderResults[0].result;
        const videos = fapFolderScan && Array.isArray(fapFolderScan.images)
          ? fapFolderScan.images.map(safeContextMedia)
            .filter((image) => image && image.mediaType === "video")
          : [];
        const exact = videos.find((image) =>
          sourceUrl && (image.url === sourceUrl || image.previewUrl === sourceUrl)
        );
        if (exact || videos.length === 1) {
          return exact || videos[0];
        }
        specializedError = videos.length > 1
          ? "This FapFolder page contains multiple videos; open the media list to choose the correct item."
          : fapFolderScan && Array.isArray(fapFolderScan.warnings)
            ? fapFolderScan.warnings.map((warning) => String(warning).slice(0, 500)).join(" ")
            : "";
      } catch (error) {
        specializedError = `FapFolder-specific collection failed: ${error.message || error}`;
      }
    }
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
          world: "MAIN",
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
        sourceUrl: /^https?:/i.test(tab && tab.url || "") ? normalizedMediaUrl(tab.url) : "",
        sourceTabId: tab && Number.isSafeInteger(tab.id) && tab.id >= 0 ? tab.id : null,
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
    return storageOperation(Boolean(tab && tab.incognito), () => storeContextIgnoreRuleLocked(image, info, tab));
  }

  async function storeContextIgnoreRuleLocked(image, info, tab) {
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
    const siteKey = DownloadLedger
      ? DownloadLedger.siteKeyForUrl(message.pageUrl)
      : Core.siteKeyForUrl(message.pageUrl);
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
      const identityKey = typeof (item && item.identityKey) === "string"
        ? item.identityKey.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300)
        : "";
      items.push({
        url: queuedUrl,
        filename,
        mediaType,
        originalIndex: index,
        siteKey,
        mediaFingerprint: DownloadLedger
          ? DownloadLedger.mediaFingerprint({ url: queuedUrl, identityKey })
          : ""
      });
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

  function downloadLedgerArea(incognito) {
    return incognito ? browser.storage.session : browser.storage.local;
  }

  async function loadDownloadLedger(incognito) {
    if (!DownloadLedger) {
      return null;
    }
    const area = downloadLedgerArea(incognito);
    const stored = await area.get(DownloadLedger.STORAGE_KEY);
    return DownloadLedger.hydrate(stored && stored[DownloadLedger.STORAGE_KEY]);
  }

  async function saveDownloadLedger(incognito, state) {
    if (!DownloadLedger) {
      return;
    }
    await downloadLedgerArea(incognito).set({
      [DownloadLedger.STORAGE_KEY]: DownloadLedger.hydrate(state)
    });
  }

  function ledgerIdentityForQueueTask(job, task) {
    if (!DownloadLedger || !task) {
      return { siteKey: "", fingerprint: "" };
    }
    const siteKey = DownloadLedger.siteKeyForUrl(task.siteKey || job && job.source);
    const fingerprint = DownloadLedger.normalizeFingerprint(task.mediaFingerprint) ||
      DownloadLedger.mediaFingerprint({ url: task.url });
    return { siteKey, fingerprint };
  }

  async function recordCompletedLedgerTasksLocked(context) {
    if (!DownloadLedger || !context || !context.state) {
      return false;
    }
    const completed = [];
    const markable = [];
    for (const job of context.state.jobs) {
      for (const task of job.tasks) {
        if (task.status !== "complete" || task.ledgerRecorded === true) {
          continue;
        }
        const identity = ledgerIdentityForQueueTask(job, task);
        markable.push(task);
        if (identity.siteKey && identity.fingerprint) {
          completed.push({
            ...identity,
            completedAt: task.completedAt || task.updatedAt || Date.now(),
            filename: task.filename,
            mediaType: task.mediaType
          });
        }
      }
    }
    if (!markable.length) {
      return false;
    }
    try {
      if (completed.length) {
        const current = await loadDownloadLedger(context.incognito);
        const updated = DownloadLedger.recordCompletions(current, completed);
        await saveDownloadLedger(context.incognito, updated);
      }
      for (const task of markable) {
        task.ledgerRecorded = true;
      }
      context.dirty = true;
      return true;
    } catch (error) {
      console.error("AnyDownload could not update its completed-download ledger.", error);
      return false;
    }
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

  function storageOperation(incognito, callback) {
    const context = queueContext(incognito);
    const result = context.operation
      .catch(() => undefined)
      .then(async () => {
        if (!incognito && cloudSync) await cloudSync.recover();
        return callback(context);
      });
    context.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  function queueOperation(incognito, callback) {
    return storageOperation(incognito, async (context) => {
      await loadQueueLocked(context);
      return callback(context);
    });
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
      task.completedAt,
      task.ledgerRecorded === true
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
    let searchCursor = 0;

    async function searchWorker() {
      while (searchCursor < tasks.length) {
        const taskIndex = searchCursor;
        const task = tasks[taskIndex];
        searchCursor += 1;
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
            snapshots[taskIndex] = snapshot;
          } else if (markMissing) {
            missingTasks[taskIndex] = task;
          }
        } catch (_error) {
          // Transient API failures keep the task intact so it can be reconciled
          // on a later wake instead of being mistaken for a removed download.
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(QUEUE_RECONCILE_CONCURRENCY, tasks.length) },
      () => searchWorker()
    ));
    context.state = DownloadQueue.applyDownloadSnapshots(context.state, snapshots.filter(Boolean));
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
      if (!task) {
        continue;
      }
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
    const reconciled = await reconcileQueueLocked(context, true);
    const ledgerChanged = await recordCompletedLedgerTasksLocked(context);
    if (reconciled || ledgerChanged || context.dirty) {
      await persistQueueLocked(context);
    }
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

  function queueProgressSnapshot(value) {
    return {
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
    };
  }

  function queueDashboardSnapshot(state) {
    const totals = queueProgressSnapshot(DownloadQueue.progressSummary(state));
    const stats = state.stats || {};
    const lifetime = stats.lifetime || {};
    const storedToday = stats.today || {};
    const currentDay = DownloadQueue.dayKey();
    const today = storedToday.date === currentDay ? storedToday : {};
    const currentJobs = state.jobs
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((job) => {
        const counts = queueProgressSnapshot(DownloadQueue.progressSummary(state, job.id));
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
        acceptedIndexes: Array.isArray(result.acceptedIndexes)
          ? result.acceptedIndexes.map((index) => batch.items[index] && batch.items[index].originalIndex)
            .filter((index) => Number.isInteger(index))
          : [],
        failed: batch.total - result.accepted,
        folder: batch.folder,
        jobId: result.jobId,
        errors,
        warning,
        error: result.accepted ? "" : errors[0] && errors[0].error || "The download queue is full."
      };
    });
  }

  function trackerPublicSnapshot(tracker) {
    if (!tracker) {
      return null;
    }
    const { seen: _seen, ...snapshot } = tracker;
    return { ...snapshot, seenCount: Array.isArray(tracker.seen) ? tracker.seen.length : 0 };
  }

  async function trackerSnapshotWithReviewCount(tracker) {
    const snapshot = tracker && Object.prototype.hasOwnProperty.call(tracker, "seenCount")
      ? { ...tracker }
      : trackerPublicSnapshot(tracker);
    if (!snapshot || !Tracker) {
      return snapshot;
    }
    const reviews = await loadTrackerReviews();
    return {
      ...snapshot,
      pendingReviewCount: reviews.filter((item) => item.trackerId === snapshot.id).length
    };
  }

  async function loadTrackers() {
    if (!Tracker) {
      return [];
    }
    const stored = await browser.storage.local.get(Tracker.STORAGE_KEY);
    return Tracker.normalizeTrackers(stored && stored[Tracker.STORAGE_KEY], Date.now());
  }

  async function saveTrackers(trackers) {
    await browser.storage.local.set({
      [Tracker.STORAGE_KEY]: Tracker.normalizeTrackers(trackers, Date.now())
    });
  }

  async function loadTrackerReviews() {
    if (!Tracker) {
      return [];
    }
    const stored = await browser.storage.local.get(Tracker.REVIEW_STORAGE_KEY);
    return Tracker.normalizeReviewItems(stored && stored[Tracker.REVIEW_STORAGE_KEY]);
  }

  async function saveTrackerReviews(items) {
    await browser.storage.local.set({
      [Tracker.REVIEW_STORAGE_KEY]: Tracker.normalizeReviewItems(items)
    });
  }

  function trackerReviewPublicSnapshot(item) {
    return item ? { ...item } : null;
  }

  function queueTrackerMutation(callback) {
    const operation = trackerMutationQueue.catch(() => undefined).then(callback);
    trackerMutationQueue = operation;
    operation.catch(() => undefined);
    return operation;
  }

  function updateStoredTracker(id, updater) {
    return queueTrackerMutation(async () => {
      const trackers = await loadTrackers();
      const index = trackers.findIndex((tracker) => tracker.id === id);
      if (index < 0) {
        return null;
      }
      const updated = Tracker.normalizeTracker(updater(trackers[index]), Date.now());
      if (!updated) {
        throw new Error("The tracker update is invalid.");
      }
      trackers[index] = updated;
      await saveTrackers(trackers);
      return updated;
    });
  }

  function trackerAlarmName(id) {
    return `${Tracker.ALARM_PREFIX}${id}`;
  }

  async function syncTrackerAlarm(tracker) {
    if (!Tracker || !browser.alarms) {
      return;
    }
    const name = trackerAlarmName(tracker.id);
    if (!tracker.enabled) {
      await browser.alarms.clear(name);
      return;
    }
    const nextRunAt = Math.max(
      Date.now() + 1000,
      Number(tracker.nextRunAt) || Date.now() + tracker.intervalMinutes * 60000
    );
    browser.alarms.create(name, {
      when: nextRunAt,
      periodInMinutes: tracker.intervalMinutes
    });
  }

  async function reconcileTrackerAlarms() {
    if (!Tracker || !browser.alarms || typeof browser.alarms.getAll !== "function") {
      return;
    }
    const trackers = await loadTrackers();
    const known = new Map(trackers.map((tracker) => [trackerAlarmName(tracker.id), tracker]));
    const alarms = await browser.alarms.getAll();
    const existing = new Map((alarms || []).map((alarm) => [alarm.name, alarm]));
    for (const alarm of alarms || []) {
      if (alarm.name.startsWith(Tracker.ALARM_PREFIX) && !known.has(alarm.name)) {
        await browser.alarms.clear(alarm.name);
      }
    }
    for (const tracker of trackers) {
      const alarm = existing.get(trackerAlarmName(tracker.id));
      if (!tracker.enabled) {
        if (alarm) {
          await browser.alarms.clear(alarm.name);
        }
        continue;
      }
      if (!alarm || Number(alarm.periodInMinutes) !== tracker.intervalMinutes) {
        await syncTrackerAlarm(tracker);
      }
    }
  }

  function trackerRunError(message, code, status, retryAfterMinutes) {
    const error = new Error(message);
    error.trackerCode = code || "request";
    error.httpStatus = Number(status) || 0;
    error.retryAfterMinutes = Number(retryAfterMinutes) || 0;
    return error;
  }

  function retryAfterMinutes(response) {
    const raw = String(response && response.headers && response.headers.get("retry-after") || "").trim();
    if (!raw) {
      return 0;
    }
    if (/^\d+$/.test(raw)) {
      return Math.min(24 * 60, Math.max(1, Math.ceil(Number(raw) / 60)));
    }
    const time = Date.parse(raw);
    return Number.isFinite(time)
      ? Math.min(24 * 60, Math.max(1, Math.ceil((time - Date.now()) / 60000)))
      : 0;
  }

  async function fetchTrackerDocumentWithSignal(tracker, pageUrl, signal) {
    const response = await fetch(pageUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" }
    });
    if (!response.ok) {
      if (response.status === 429) {
        throw trackerRunError(
          "The website rate-limited the tracker (HTTP 429).",
          "rate_limited",
          response.status,
          retryAfterMinutes(response)
        );
      }
      const code = [401, 403].includes(response.status)
        ? "authorization"
        : response.status >= 500
          ? "server"
          : "request";
      throw trackerRunError(`The tracked page returned HTTP ${response.status}.`, code, response.status);
    }
    const responseUrl = Tracker.normalizePageUrl(response.url || pageUrl);
    if (!responseUrl || new URL(responseUrl).origin !== new URL(tracker.url).origin) {
      throw trackerRunError("The tracked page redirected to a different website.", "redirect");
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
      throw trackerRunError(
        `The tracked URL returned ${contentType.split(";", 1)[0]} instead of HTML.`,
        "content"
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > Tracker.MAX_HTML_BYTES) {
      throw trackerRunError("The tracked page is larger than the 4 MB safety limit.", "content");
    }
    let bytes;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        const chunk = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value || 0);
        total += chunk.byteLength;
        if (total > Tracker.MAX_HTML_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw trackerRunError("The tracked page is larger than the 4 MB safety limit.", "content");
        }
        chunks.push(chunk);
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > Tracker.MAX_HTML_BYTES) {
        throw trackerRunError("The tracked page is larger than the 4 MB safety limit.", "content");
      }
    }
    if (typeof DOMParser !== "function") {
      throw trackerRunError("Firefox could not initialize the tracker HTML parser.", "parser");
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const documentObject = new DOMParser().parseFromString(html, "text/html");
    if (!documentObject || !documentObject.documentElement) {
      throw trackerRunError("Firefox could not parse the tracked page.", "parser");
    }
    return { documentObject, responseUrl };
  }

  async function fetchTrackerDocument(tracker, pageUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Tracker.REQUEST_TIMEOUT_MS);
    try {
      return await fetchTrackerDocumentWithSignal(tracker, pageUrl, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function trackerPermissionGranted(tracker) {
    if (!browser.permissions || typeof browser.permissions.contains !== "function") {
      return true;
    }
    return browser.permissions.contains({
      origins: [Tracker.permissionPatternForUrl(tracker.url)]
    });
  }

  async function collectTrackerPages(tracker) {
    const pagination = tracker.pagination || { mode: "none", maxPages: 1 };
    const media = [];
    const mediaUrls = new Set();
    const visited = new Set();
    let currentUrl = tracker.url;
    let pageTitle = tracker.pageTitle;
    let payloadLength = 0;
    let pagesChecked = 0;

    while (currentUrl && pagesChecked < pagination.maxPages && !visited.has(currentUrl)) {
      visited.add(currentUrl);
      const { documentObject, responseUrl } = await fetchTrackerDocument(tracker, currentUrl);
      pagesChecked += 1;
      if (pagesChecked === 1) {
        pageTitle = String(documentObject.title || tracker.pageTitle || tracker.url)
          .trim().slice(0, 300) || tracker.pageTitle;
      }
      const remainingItems = Tracker.MAX_ITEMS_PER_SCAN - media.length;
      const remainingPayload = Core.MAX_BATCH_TOTAL_URL_LENGTH - payloadLength;
      const discovered = Tracker.extractMediaFromDocument(documentObject, responseUrl, {
        maxItems: Math.max(1, remainingItems),
        maxPayloadLength: Math.max(1024, remainingPayload)
      });
      let added = 0;
      for (const item of discovered) {
        if (media.length >= Tracker.MAX_ITEMS_PER_SCAN || mediaUrls.has(item.url)) {
          continue;
        }
        const length = String(item.url || "").length;
        if (payloadLength + length > Core.MAX_BATCH_TOTAL_URL_LENGTH) {
          break;
        }
        mediaUrls.add(item.url);
        media.push(item);
        payloadLength += length;
        added += 1;
      }
      if (media.length >= Tracker.MAX_ITEMS_PER_SCAN || pagination.mode === "none") {
        break;
      }
      if (pagination.mode === "next-link") {
        currentUrl = Tracker.extractNextPageUrl(
          documentObject,
          responseUrl,
          pagination.nextSelector
        );
      } else if (pagination.mode === "url-template") {
        if (pagesChecked > 1 && added === 0) {
          break;
        }
        currentUrl = Tracker.pageUrlFromTemplate(
          pagination.urlTemplate,
          pagesChecked + 1,
          tracker.url
        );
      } else {
        currentUrl = "";
      }
    }
    return { media, pageTitle, pagesChecked };
  }

  function trackerBackoffMinutes(tracker, error, consecutiveErrors) {
    const interval = Math.max(Tracker.MIN_INTERVAL_MINUTES, Number(tracker.intervalMinutes) || 60);
    const exponential = Math.min(24 * 60, 15 * (2 ** Math.min(6, Math.max(0, consecutiveErrors - 1))));
    return Math.min(
      24 * 60,
      Math.max(interval, exponential, Number(error && error.retryAfterMinutes) || 0)
    );
  }

  function finishTrackerRun(id, startedAt, reason, changes, activity) {
    const finishedAt = Date.now();
    return updateStoredTracker(id, (current) => ({
      ...current,
      ...changes,
      updatedAt: finishedAt,
      lastDurationMs: Math.max(0, finishedAt - startedAt),
      activity: Tracker.appendActivity(current.activity, {
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        reason,
        ...activity
      })
    }));
  }

  async function notifyTracker(tracker, kind, message) {
    if (!tracker || !browser.notifications || typeof browser.notifications.create !== "function") {
      return;
    }
    const enabled = kind === "matches"
      ? tracker.notifications && tracker.notifications.newMatches
      : tracker.notifications && tracker.notifications.errors;
    if (!enabled) {
      return;
    }
    await browser.notifications.create(`anydownload-tracker:${tracker.id}:${kind}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/image-downloader-illustrated-v2-96.png"),
      title: kind === "matches" ? "AnyDownload found new media" : "AnyDownload tracker needs attention",
      message: String(message || "").slice(0, 500)
    });
  }

  function trackerDownloadItems(tracker, media) {
    const date = new Date();
    const usedNames = new Set();
    return media.map((item, index) => {
      const mediaType = item.mediaType === "video" ? "video" : "image";
      const fallback = (Core.filenameForMedia || Core.filenameForImage)(
        item.url,
        index,
        mediaType
      );
      const filename = Templates.render(tracker.filenameTemplate, {
        filename: item.filename || fallback,
        url: item.url,
        pageUrl: tracker.url,
        pageTitle: tracker.pageTitle,
        width: item.width,
        height: item.height,
        mimeType: item.mimeType,
        mediaType,
        index: index + 1,
        date
      }, { usedNames });
      return { ...item, filename };
    });
  }

  async function addTrackerReviewMatches(tracker, entries, pageTitle) {
    return queueTrackerMutation(async () => {
      const current = await loadTrackerReviews();
      const rendered = trackerDownloadItems(
        { ...tracker, pageTitle: pageTitle || tracker.pageTitle },
        entries.map((entry) => entry.item)
      );
      const additions = entries.map((entry, index) => ({
        ...rendered[index],
        sourceFilename: entry.item.filename || (Core.filenameForMedia || Core.filenameForImage)(
          entry.item.url,
          index,
          entry.item.mediaType
        ),
        trackerId: tracker.id,
        fingerprint: entry.fingerprint,
        detectedAt: Date.now(),
        pageTitle: pageTitle || tracker.pageTitle,
        pageUrl: tracker.url
      }));
      const added = Tracker.addReviewItems(current, additions, Date.now());
      await saveTrackerReviews(added.items);
      const acceptedIds = new Set(added.acceptedIds);
      return {
        reviews: added.items,
        acceptedFingerprints: additions
          .filter((item) => acceptedIds.has(`${tracker.id}:${item.fingerprint}`))
          .map((item) => item.fingerprint),
        rejected: added.rejected
      };
    });
  }

  async function refreshPendingTrackerReviews(tracker, entries, pageTitle) {
    if (Tracker.normalizeAction(tracker && tracker.action) !== "review") {
      return new Set();
    }
    const current = await loadTrackerReviews();
    const pending = new Map(current
      .filter((item) => item.trackerId === tracker.id)
      .map((item) => [item.fingerprint, item]));
    const refreshed = entries.filter((entry) => {
      const existing = pending.get(entry.fingerprint);
      return existing && (
        existing.url !== entry.item.url ||
        existing.previewUrl !== String(entry.item.previewUrl || "")
      );
    });
    if (refreshed.length) {
      await addTrackerReviewMatches(tracker, refreshed, pageTitle);
    }
    return new Set(pending.keys());
  }

  async function performTrackerRun(id, reason) {
    const trackers = await loadTrackers();
    const tracker = trackers.find((candidate) => candidate.id === id);
    if (!tracker) {
      throw new Error("This tracker no longer exists.");
    }
    if (reason === "alarm" && !tracker.enabled) {
      return trackerPublicSnapshot(tracker);
    }
    const startedAt = Date.now();
    if (reason === "alarm" && Number(tracker.nextRunAt) > startedAt + 1000) {
      return trackerPublicSnapshot(tracker);
    }
    await updateStoredTracker(id, (current) => ({
      ...current,
      lastRunAt: startedAt,
      nextRunAt: startedAt + current.intervalMinutes * 60000
    }));

    let pagesChecked = 0;
    try {
      if (!await trackerPermissionGranted(tracker)) {
        throw trackerRunError(
          "Website access was removed. Open the tracked page in AnyDownload and grant access again.",
          "permission"
        );
      }
      const collected = await collectTrackerPages(tracker);
      pagesChecked = collected.pagesChecked;
      const pageTitle = collected.pageTitle;
      const matches = collected.media.filter((item) =>
        Filters.matchesSmartFilters(item, tracker.filters) &&
        Tracker.matchesTrackerRules(item, tracker.matching)
      );
      const fingerprintsInDocument = new Set();
      const fingerprinted = [];
      for (const item of matches) {
        const fingerprint = Tracker.mediaFingerprint(item);
        if (!fingerprint || fingerprintsInDocument.has(fingerprint)) {
          continue;
        }
        fingerprintsInDocument.add(fingerprint);
        fingerprinted.push({ item, fingerprint });
      }
      const seen = new Set(tracker.seen);
      const pendingReviewFingerprints = await refreshPendingTrackerReviews(
        tracker,
        fingerprinted,
        pageTitle
      );

      if (!tracker.initialized && !tracker.downloadInitial) {
        const baseline = fingerprinted.map((entry) => entry.fingerprint);
        const finishedAt = Date.now();
        const updated = await finishTrackerRun(id, startedAt, reason, {
          pageTitle,
          initialized: true,
          seen: Tracker.recordSeen(tracker.seen, baseline),
          lastSuccessAt: finishedAt,
          nextRunAt: finishedAt + tracker.intervalMinutes * 60000,
          backoffUntil: 0,
          consecutiveErrors: 0,
          consecutiveAuthorizationErrors: 0,
          autoPausedReason: "",
          lastFound: fingerprinted.length,
          lastDiscovered: 0,
          lastReviewed: 0,
          lastQueued: 0,
          lastPagesChecked: pagesChecked,
          lastError: ""
        }, {
          status: "baseline",
          pagesChecked,
          found: fingerprinted.length,
          discovered: 0,
          reviewed: 0,
          queued: 0,
          message: `Baseline recorded with ${fingerprinted.length} matching item${fingerprinted.length === 1 ? "" : "s"}.`
        });
        return trackerPublicSnapshot(updated);
      }

      const fresh = fingerprinted
        .filter((entry) =>
          !seen.has(entry.fingerprint) && !pendingReviewFingerprints.has(entry.fingerprint)
        )
        .slice(0, tracker.matching.maxDownloadsPerRun);
      if (!fresh.length) {
        const finishedAt = Date.now();
        const updated = await finishTrackerRun(id, startedAt, reason, {
          pageTitle,
          initialized: true,
          lastSuccessAt: finishedAt,
          nextRunAt: finishedAt + tracker.intervalMinutes * 60000,
          backoffUntil: 0,
          consecutiveErrors: 0,
          consecutiveAuthorizationErrors: 0,
          autoPausedReason: "",
          lastFound: fingerprinted.length,
          lastDiscovered: 0,
          lastReviewed: 0,
          lastQueued: 0,
          lastPagesChecked: pagesChecked,
          lastError: ""
        }, {
          status: "success",
          pagesChecked,
          found: fingerprinted.length,
          discovered: 0,
          reviewed: 0,
          queued: 0,
          message: "No unseen matching media was found."
        });
        return trackerPublicSnapshot(updated);
      }

      const alreadyDownloaded = await downloadedFingerprintSet(false, tracker.url, fresh);
      const downloadedFingerprints = fresh
        .map((entry) => entry.fingerprint)
        .filter((fingerprint) => alreadyDownloaded.has(fingerprint));
      const actionable = fresh.filter((entry) => !alreadyDownloaded.has(entry.fingerprint));
      if (!actionable.length) {
        const finishedAt = Date.now();
        const updated = await finishTrackerRun(id, startedAt, reason, {
          pageTitle,
          initialized: true,
          seen: Tracker.recordSeen(tracker.seen, downloadedFingerprints),
          lastSuccessAt: finishedAt,
          nextRunAt: finishedAt + tracker.intervalMinutes * 60000,
          backoffUntil: 0,
          consecutiveErrors: 0,
          consecutiveAuthorizationErrors: 0,
          autoPausedReason: "",
          lastFound: fingerprinted.length,
          lastDiscovered: 0,
          lastReviewed: 0,
          lastQueued: 0,
          lastPagesChecked: pagesChecked,
          lastError: ""
        }, {
          status: "success",
          pagesChecked,
          found: fingerprinted.length,
          discovered: 0,
          reviewed: 0,
          queued: 0,
          message: `${downloadedFingerprints.length} unseen tracker match${downloadedFingerprints.length === 1 ? " was" : "es were"} already downloaded or queued.`
        });
        return trackerPublicSnapshot(updated);
      }

      const action = Tracker.normalizeAction(tracker.action);
      let acceptedFingerprints = [];
      let reviewed = 0;
      let queued = 0;
      let partialError = "";
      let successMessage = "";
      let notificationMessage = "";

      if (action === "notify") {
        acceptedFingerprints = actionable.map((entry) => entry.fingerprint);
        successMessage = `Found ${acceptedFingerprints.length} new match${acceptedFingerprints.length === 1 ? "" : "es"}; notification-only mode queued nothing.`;
        notificationMessage = `${acceptedFingerprints.length} new match${acceptedFingerprints.length === 1 ? " was" : "es were"} found on ${pageTitle}. Nothing was downloaded.`;
      } else if (action === "review") {
        const reviewResult = await addTrackerReviewMatches(tracker, actionable, pageTitle);
        acceptedFingerprints = reviewResult.acceptedFingerprints;
        reviewed = acceptedFingerprints.length;
        const rejectedCount = actionable.length - acceptedFingerprints.length;
        partialError = rejectedCount
          ? `${rejectedCount} new match${rejectedCount === 1 ? "" : "es"} could not fit in the review inbox and will be retried.`
          : "";
        successMessage = partialError || `Added ${reviewed} new match${reviewed === 1 ? "" : "es"} to review.`;
        if (reviewed) {
          notificationMessage = `${reviewed} new match${reviewed === 1 ? " is" : "es are"} waiting for review from ${pageTitle}.`;
        }
      } else {
        const downloadItems = trackerDownloadItems(tracker, actionable.map((entry) => entry.item));
        const queueResult = await enqueueDownloadBatch(validateBatch({
          type: "DOWNLOAD_BATCH",
          folder: tracker.folder,
          saveAs: false,
          incognito: false,
          pageTitle,
          pageUrl: tracker.url,
          items: downloadItems
        }));
        const acceptedIndexes = Array.isArray(queueResult.acceptedIndexes)
          ? queueResult.acceptedIndexes
          : [];
        acceptedFingerprints = acceptedIndexes
          .map((index) => actionable[index] && actionable[index].fingerprint)
          .filter(Boolean);
        if (!queueResult.ok || !acceptedFingerprints.length) {
          throw trackerRunError(
            queueResult.error || "No new tracker matches could be queued.",
            "queue"
          );
        }
        queued = acceptedFingerprints.length;
        partialError = queueResult.failed
          ? `${queueResult.failed} new match${queueResult.failed === 1 ? "" : "es"} could not be queued and will be retried.`
          : "";
        successMessage = partialError || `Queued ${queued} new match${queued === 1 ? "" : "es"}.`;
        notificationMessage = `${queued} new match${queued === 1 ? " was" : "es were"} added to Downloads from ${pageTitle}.`;
      }

      const finishedAt = Date.now();
      const updated = await finishTrackerRun(id, startedAt, reason, {
        pageTitle,
        initialized: true,
        seen: Tracker.recordSeen(
          tracker.seen,
          [...downloadedFingerprints, ...acceptedFingerprints]
        ),
        lastSuccessAt: finishedAt,
        nextRunAt: finishedAt + tracker.intervalMinutes * 60000,
        backoffUntil: 0,
        consecutiveErrors: 0,
        consecutiveAuthorizationErrors: 0,
        autoPausedReason: "",
        lastFound: fingerprinted.length,
        lastDiscovered: actionable.length,
        lastReviewed: reviewed,
        lastQueued: queued,
        lastPagesChecked: pagesChecked,
        lastError: partialError
      }, {
        status: partialError ? "partial" : "success",
        pagesChecked,
        found: fingerprinted.length,
        discovered: actionable.length,
        reviewed,
        queued,
        message: successMessage
      });
      if (notificationMessage) {
        await notifyTracker(updated, "matches", notificationMessage).catch(() => undefined);
      }
      return trackerPublicSnapshot(updated);
    } catch (error) {
      const message = error && error.name === "AbortError"
        ? "The tracked page did not respond within 15 seconds."
        : error && error.message ? error.message : String(error);
      const code = error && error.name === "AbortError"
        ? "timeout"
        : String(error && error.trackerCode || "network");
      const consecutiveErrors = tracker.consecutiveErrors + 1;
      const consecutiveAuthorizationErrors = code === "authorization"
        ? tracker.consecutiveAuthorizationErrors + 1
        : 0;
      const shouldAutoPause = code === "permission" ||
        consecutiveAuthorizationErrors >= 3;
      const backoffMinutes = trackerBackoffMinutes(tracker, error, consecutiveErrors);
      const finishedAt = Date.now();
      const nextRunAt = finishedAt + backoffMinutes * 60000;
      const autoPausedReason = shouldAutoPause
        ? code === "permission"
          ? "Site access was removed."
          : "Paused after three consecutive authorization failures."
        : "";
      const displayMessage = autoPausedReason
        ? `${message} ${autoPausedReason}`
        : `${message} Next automatic retry is delayed for ${backoffMinutes} minutes.`;
      const updated = await finishTrackerRun(id, startedAt, reason, {
        enabled: shouldAutoPause ? false : tracker.enabled,
        nextRunAt,
        backoffUntil: shouldAutoPause ? 0 : nextRunAt,
        consecutiveErrors,
        consecutiveAuthorizationErrors,
        autoPausedReason,
        lastFound: 0,
        lastDiscovered: 0,
        lastReviewed: 0,
        lastQueued: 0,
        lastPagesChecked: pagesChecked,
        lastError: displayMessage
      }, {
        status: "error",
        pagesChecked,
        found: 0,
        discovered: 0,
        reviewed: 0,
        queued: 0,
        message: displayMessage
      });
      if (consecutiveErrors === 1 || shouldAutoPause) {
        await notifyTracker(updated, "error", `${updated.pageTitle}: ${displayMessage}`)
          .catch(() => undefined);
      }
      return trackerPublicSnapshot(updated);
    }
  }

  function runTracker(id, reason) {
    const existing = trackerRuns.get(id);
    if (existing) {
      return existing;
    }
    const operation = performTrackerRun(id, reason)
      .then(async (tracker) => {
        if (tracker) {
          await syncTrackerAlarm(tracker);
        }
        return tracker;
      })
      .finally(() => {
        if (trackerRuns.get(id) === operation) {
          trackerRuns.delete(id);
        }
      });
    trackerRuns.set(id, operation);
    return operation;
  }

  async function upsertTracker(message) {
    if (!Tracker) {
      throw new Error("The tracker engine is unavailable.");
    }
    if (message.incognito) {
      throw new Error("Background trackers are unavailable in private windows.");
    }
    const url = Tracker.normalizePageUrl(message.tracker && message.tracker.url);
    const permissionPattern = Tracker.permissionPatternForUrl(url);
    if (!url || !permissionPattern) {
      throw new Error("The tracked page URL is invalid.");
    }
    if (browser.permissions && typeof browser.permissions.contains === "function" &&
      !await browser.permissions.contains({ origins: [permissionPattern] })) {
      throw new Error("Website access was not granted for this tracker.");
    }
    const stored = await queueTrackerMutation(async () => {
      const trackers = await loadTrackers();
      const existingIndex = trackers.findIndex((tracker) => tracker.url === url);
      if (existingIndex < 0 && trackers.length >= Tracker.MAX_TRACKERS) {
        throw new Error(`AnyDownload supports at most ${Tracker.MAX_TRACKERS} trackers.`);
      }
      const now = Date.now();
      const existing = existingIndex >= 0 ? trackers[existingIndex] : null;
      const id = existing && existing.id || `tracker-${crypto.randomUUID()}`;
      const supplied = message.tracker && typeof message.tracker === "object" ? message.tracker : {};
      const suppliedMatching = Object.prototype.hasOwnProperty.call(supplied, "matching")
        ? supplied.matching
        : Object.prototype.hasOwnProperty.call(supplied, "query")
          ? { ...(existing && existing.matching || {}), includeText: supplied.query }
          : existing && existing.matching;
      const recoveringFromAutoPause = Boolean(existing && existing.autoPausedReason);
      const candidate = Tracker.normalizeTracker({
        ...existing,
        ...supplied,
        id,
        url,
        matching: suppliedMatching,
        seen: existing ? existing.seen : [],
        initialized: existing ? existing.initialized : false,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        enabled: existing && !recoveringFromAutoPause ? existing.enabled : true,
        backoffUntil: recoveringFromAutoPause ? 0 : existing && existing.backoffUntil,
        consecutiveErrors: recoveringFromAutoPause ? 0 : existing && existing.consecutiveErrors,
        consecutiveAuthorizationErrors: recoveringFromAutoPause
          ? 0
          : existing && existing.consecutiveAuthorizationErrors,
        autoPausedReason: recoveringFromAutoPause ? "" : existing && existing.autoPausedReason,
        nextRunAt: 0
      }, now);
      const requestedPaginationMode = String(
        supplied.pagination && supplied.pagination.mode || ""
      ).toLowerCase();
      if (
        candidate &&
        ["next-link", "url-template"].includes(requestedPaginationMode) &&
        candidate.pagination.mode !== requestedPaginationMode
      ) {
        throw new Error("The pagination settings are invalid or point to a different website.");
      }
      const next = candidate && Tracker.normalizeTracker({
        ...candidate,
        nextRunAt: now + candidate.intervalMinutes * 60000
      }, now);
      if (!next) {
        throw new Error("The tracker settings are invalid.");
      }
      if (existingIndex >= 0) {
        trackers[existingIndex] = next;
      } else {
        trackers.push(next);
      }
      await saveTrackers(trackers);
      return next;
    });
    await syncTrackerAlarm(stored);
    return stored.enabled ? runTracker(stored.id, "save") : trackerPublicSnapshot(stored);
  }

  async function trackerReviewAction(message) {
    const action = String(message && message.action || "");
    const id = String(message && message.id || "").slice(0, 160);
    if (!["approve", "dismiss"].includes(action) || !id) {
      throw new Error("The review action is invalid.");
    }
    const snapshot = await queueTrackerMutation(async () => {
      const reviews = await loadTrackerReviews();
      const review = reviews.find((item) => item.id === id);
      if (!review) {
        throw new Error("This review item no longer exists.");
      }
      if (action === "dismiss") {
        const updated = Tracker.removeReviewItems(reviews, [id]);
        await saveTrackerReviews(updated);
        return { review, tracker: null, reviews: updated };
      }
      const trackers = await loadTrackers();
      const tracker = trackers.find((item) => item.id === review.trackerId);
      if (!tracker) {
        throw new Error("The tracker for this review item no longer exists. Dismiss the item instead.");
      }
      return { review, tracker, reviews };
    });
    if (action === "dismiss") {
      return {
        ok: true,
        action,
        queued: 0,
        reviews: snapshot.reviews.map(trackerReviewPublicSnapshot)
      };
    }

    const alreadyDownloaded = await downloadedFingerprintSet(
      false,
      snapshot.tracker.url,
      [snapshot.review.fingerprint]
    );
    let queueResult = null;
    if (!alreadyDownloaded.has(snapshot.review.fingerprint)) {
      const [approvedItem] = trackerDownloadItems(
        {
          ...snapshot.tracker,
          pageTitle: snapshot.review.pageTitle || snapshot.tracker.pageTitle
        },
        [{
          ...snapshot.review,
          filename: snapshot.review.sourceFilename || snapshot.review.filename
        }]
      );
      queueResult = await enqueueDownloadBatch(validateBatch({
        type: "DOWNLOAD_BATCH",
        folder: snapshot.tracker.folder,
        saveAs: false,
        incognito: false,
        pageTitle: snapshot.review.pageTitle || snapshot.tracker.pageTitle,
        pageUrl: snapshot.tracker.url,
        items: [approvedItem]
      }));
      if (!queueResult.ok || !queueResult.queued) {
        throw new Error(queueResult.error || "The review item could not be queued.");
      }
    }
    const reviews = await queueTrackerMutation(async () => {
      const current = await loadTrackerReviews();
      const updated = Tracker.removeReviewItems(current, [id]);
      await saveTrackerReviews(updated);
      return updated;
    });
    return {
      ok: true,
      action,
      queued: queueResult ? Number(queueResult.queued) || 0 : 0,
      alreadyDownloaded: !queueResult,
      reviews: reviews.map(trackerReviewPublicSnapshot)
    };
  }

  async function trackerMessage(message) {
    if (!Tracker) {
      throw new Error("The tracker engine is unavailable.");
    }
    if (message.type === "GET_TRACKER") {
      const url = Tracker.normalizePageUrl(message.url);
      const trackers = await loadTrackers();
      const tracker = trackers.find((item) => item.url === url);
      const reviews = tracker ? await loadTrackerReviews() : [];
      const snapshot = trackerPublicSnapshot(tracker);
      return {
        ok: true,
        tracker: snapshot
          ? { ...snapshot, pendingReviewCount: reviews.filter((item) => item.trackerId === tracker.id).length }
          : null
      };
    }
    if (message.type === "GET_TRACKERS") {
      const trackers = await loadTrackers();
      const reviews = await loadTrackerReviews();
      return {
        ok: true,
        trackers: trackers.map((tracker) => ({
          ...trackerPublicSnapshot(tracker),
          pendingReviewCount: reviews.filter((item) => item.trackerId === tracker.id).length
        })),
        reviews: reviews.map(trackerReviewPublicSnapshot),
        maxTrackers: Tracker.MAX_TRACKERS,
        maxReviews: Tracker.MAX_REVIEW_ITEMS
      };
    }
    if (message.type === "UPSERT_TRACKER") {
      return { ok: true, tracker: await trackerSnapshotWithReviewCount(await upsertTracker(message)) };
    }
    if (message.type === "RUN_TRACKER") {
      const id = String(message.id || "");
      return { ok: true, tracker: await trackerSnapshotWithReviewCount(await runTracker(id, "manual")) };
    }
    if (message.type === "SET_TRACKER_ENABLED") {
      const enabled = Boolean(message.enabled);
      const updated = await updateStoredTracker(String(message.id || ""), (current) => ({
        ...current,
        enabled,
        updatedAt: Date.now(),
        nextRunAt: Date.now() + current.intervalMinutes * 60000,
        backoffUntil: enabled ? 0 : current.backoffUntil,
        consecutiveErrors: enabled ? 0 : current.consecutiveErrors,
        consecutiveAuthorizationErrors: enabled ? 0 : current.consecutiveAuthorizationErrors,
        autoPausedReason: enabled ? "" : current.autoPausedReason
      }));
      if (!updated) {
        throw new Error("This tracker no longer exists.");
      }
      await syncTrackerAlarm(updated);
      return { ok: true, tracker: await trackerSnapshotWithReviewCount(updated) };
    }
    if (message.type === "SET_ALL_TRACKERS_ENABLED") {
      const enabled = Boolean(message.enabled);
      const updated = await queueTrackerMutation(async () => {
        const now = Date.now();
        const trackers = (await loadTrackers()).map((tracker) => Tracker.normalizeTracker({
          ...tracker,
          enabled,
          updatedAt: now,
          nextRunAt: now + tracker.intervalMinutes * 60000,
          backoffUntil: enabled ? 0 : tracker.backoffUntil,
          consecutiveErrors: enabled ? 0 : tracker.consecutiveErrors,
          consecutiveAuthorizationErrors: enabled ? 0 : tracker.consecutiveAuthorizationErrors,
          autoPausedReason: enabled ? "" : tracker.autoPausedReason
        }, now));
        await saveTrackers(trackers);
        return trackers;
      });
      await Promise.all(updated.map(syncTrackerAlarm));
      return { ok: true, trackers: updated.map(trackerPublicSnapshot) };
    }
    if (message.type === "DELETE_TRACKER") {
      const id = String(message.id || "");
      await queueTrackerMutation(async () => {
        const trackers = await loadTrackers();
        const reviews = await loadTrackerReviews();
        await Promise.all([
          saveTrackers(trackers.filter((tracker) => tracker.id !== id)),
          saveTrackerReviews(reviews.filter((item) => item.trackerId !== id))
        ]);
      });
      if (browser.alarms) {
        await browser.alarms.clear(trackerAlarmName(id));
      }
      return { ok: true, tracker: null };
    }
    return undefined;
  }

  function queueRelevantDownloadChange(change) {
    return Boolean(change && [
      "state",
      "paused",
      "bytesReceived",
      "totalBytes",
      "fileSize",
      "endTime",
      "filename",
      "error"
    ].some((key) => Object.prototype.hasOwnProperty.call(change, key)));
  }

  function queueChangeNeedsImmediatePersistence(change) {
    return Boolean(change && ["state", "paused", "error"].some((key) =>
      Object.prototype.hasOwnProperty.call(change, key)
    ));
  }

  async function updateQueueForDownload(incognito, change) {
    return queueOperation(incognito, async (context) => {
      const downloadId = change && change.id;
      let matchedTask = null;
      for (const job of context.state.jobs) {
        matchedTask = job.tasks.find((task) => task.downloadId === downloadId) || null;
        if (matchedTask) {
          break;
        }
      }
      if (!matchedTask) {
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

      const terminalMetadata = ["complete", "interrupted", "cancelled"]
        .includes(matchedTask.status);
      if (
        !queueChangeNeedsImmediatePersistence(change) &&
        !terminalMetadata &&
        !context.dirty
      ) {
        // Byte counters can fire many times per second. Keep them current for
        // this background lifetime, but avoid rewriting the entire durable
        // queue for every progress tick. Startup/dashboard reconciliation
        // restores them after a suspended background context.
        return true;
      }

      await recordCompletedLedgerTasksLocked(context);
      await pumpQueueLocked(context, true);
      return true;
    });
  }

  async function handleQueuedDownloadChange(change) {
    if (
      !DownloadQueue ||
      !change ||
      !Number.isInteger(change.id) ||
      !queueRelevantDownloadChange(change)
    ) {
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

  async function getDownloadDashboard(incognito, options) {
    const settings = Object.assign({ summaryOnly: false }, options || {});
    return queueOperation(Boolean(incognito), async (context) => {
      if (settings.summaryOnly) {
        return {
          ok: true,
          snapshot: {
            summary: queueProgressSnapshot(DownloadQueue.progressSummary(context.state))
          }
        };
      }
      const reconciled = await reconcileQueueLocked(context, true);
      const ledgerChanged = await recordCompletedLedgerTasksLocked(context);
      await pumpQueueLocked(context, reconciled || ledgerChanged);
      return { ok: true, snapshot: queueDashboardSnapshot(context.state) };
    });
  }

  async function downloadedFingerprintSet(incognito, siteKeyValue, entries) {
    const downloaded = new Set();
    if (!DownloadLedger) {
      return downloaded;
    }
    const siteKey = DownloadLedger.siteKeyForUrl(siteKeyValue);
    if (!siteKey) {
      return downloaded;
    }
    const ledger = await loadDownloadLedger(incognito);
    const wanted = new Set((Array.isArray(entries) ? entries : [])
      .map((entry) => DownloadLedger.normalizeFingerprint(
        typeof entry === "string" ? entry : entry && entry.fingerprint
      ))
      .filter(Boolean));
    for (const entry of ledger && ledger.entries || []) {
      if (entry.siteKey === siteKey && wanted.has(entry.fingerprint)) {
        downloaded.add(entry.fingerprint);
      }
    }
    if (DownloadQueue && wanted.size) {
      await queueOperation(Boolean(incognito), async (context) => {
        for (const job of context.state.jobs) {
          for (const task of job.tasks) {
            if (!["queued", "starting", "in_progress", "paused", "complete"].includes(task.status)) {
              continue;
            }
            const identity = ledgerIdentityForQueueTask(job, task);
            if (identity.siteKey === siteKey && wanted.has(identity.fingerprint)) {
              downloaded.add(identity.fingerprint);
            }
          }
        }
      });
    }
    return downloaded;
  }

  async function getMediaDownloadStatuses(message) {
    if (!DownloadLedger || !DownloadQueue) {
      return {
        ok: true,
        statuses: (Array.isArray(message && message.items) ? message.items : []).map(() => ({
          fingerprint: "",
          status: "new",
          completedAt: 0,
          filename: ""
        }))
      };
    }
    const rawItems = Array.isArray(message && message.items) ? message.items : [];
    if (rawItems.length > Core.MAX_BATCH_SIZE) {
      throw new Error(`At most ${Core.MAX_BATCH_SIZE} media statuses can be requested at once.`);
    }
    const siteKey = DownloadLedger.siteKeyForUrl(message && message.pageUrl);
    let payloadLength = 0;
    const items = rawItems.map((item) => {
      const url = typeof (item && item.url) === "string" ? item.url : "";
      const identityKey = typeof (item && item.identityKey) === "string"
        ? item.identityKey.slice(0, 300)
        : "";
      payloadLength += url.length + identityKey.length;
      return {
        fingerprint: DownloadLedger.mediaFingerprint({ url, identityKey })
      };
    });
    if (payloadLength > Core.MAX_BATCH_TOTAL_URL_LENGTH) {
      throw new Error("The media status request is too large.");
    }
    if (!siteKey) {
      return {
        ok: true,
        statuses: items.map((item) => ({
          fingerprint: item.fingerprint,
          status: "new",
          completedAt: 0,
          filename: ""
        }))
      };
    }

    return queueOperation(Boolean(message && message.incognito), async (context) => {
      const reconciled = await reconcileQueueLocked(context, true);
      const ledgerChanged = await recordCompletedLedgerTasksLocked(context);
      if (reconciled || ledgerChanged || context.dirty) {
        await persistQueueLocked(context);
      }
      const ledger = await loadDownloadLedger(context.incognito);
      const completedByFingerprint = new Map();
      for (const entry of ledger && ledger.entries || []) {
        if (entry.siteKey === siteKey && !completedByFingerprint.has(entry.fingerprint)) {
          completedByFingerprint.set(entry.fingerprint, entry);
        }
      }

      const queueByFingerprint = new Map();
      const statusPriority = {
        queued: 4,
        starting: 4,
        in_progress: 4,
        paused: 4,
        complete: 3,
        interrupted: 2,
        cancelled: 1
      };
      for (const job of context.state.jobs) {
        for (const task of job.tasks) {
          const identity = ledgerIdentityForQueueTask(job, task);
          if (identity.siteKey !== siteKey || !identity.fingerprint) {
            continue;
          }
          const current = queueByFingerprint.get(identity.fingerprint);
          const priority = statusPriority[task.status] || 0;
          const currentPriority = current ? statusPriority[current.status] || 0 : -1;
          if (
            !current ||
            priority > currentPriority ||
            (priority === currentPriority && Number(task.updatedAt) > Number(current.updatedAt))
          ) {
            queueByFingerprint.set(identity.fingerprint, task);
          }
        }
      }

      return {
        ok: true,
        statuses: items.map((item) => {
          const task = queueByFingerprint.get(item.fingerprint);
          const ledgerEntry = completedByFingerprint.get(item.fingerprint);
          if (task && ["queued", "starting", "in_progress", "paused"].includes(task.status)) {
            return {
              fingerprint: item.fingerprint,
              status: "queued",
              completedAt: 0,
              filename: task.filename || ""
            };
          }
          if (ledgerEntry || task && task.status === "complete") {
            return {
              fingerprint: item.fingerprint,
              status: "downloaded",
              completedAt: Number(ledgerEntry && ledgerEntry.completedAt || task && task.completedAt) || 0,
              filename: String(ledgerEntry && ledgerEntry.filename || task && task.filename || "")
            };
          }
          if (task && task.status === "interrupted") {
            return {
              fingerprint: item.fingerprint,
              status: "failed",
              completedAt: Number(task.completedAt) || 0,
              filename: task.filename || ""
            };
          }
          return {
            fingerprint: item.fingerprint,
            status: "new",
            completedAt: 0,
            filename: ""
          };
        })
      };
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

  if (globalThis.AnyDownloadCloudRuntime) {
    cloudSync = globalThis.AnyDownloadCloudRuntime.start(browser, {
      withStorageLock: (callback) => storageOperation(false, callback)
    });
  }

  browser.runtime.onInstalled.addListener(() =>
    rebuildContextMenus().catch((error) => {
      console.error("AnyDownload could not rebuild its media context menu.", error);
    }).finally(() => Promise.all([
      resumeStoredQueues(),
      reconcileTrackerAlarms()
    ]))
  );

  if (browser.runtime.onStartup && typeof browser.runtime.onStartup.addListener === "function") {
    browser.runtime.onStartup.addListener(() => Promise.all([
      resumeStoredQueues(),
      reconcileTrackerAlarms()
    ]));
  }

  if (Tracker && browser.alarms && browser.alarms.onAlarm) {
    browser.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || !String(alarm.name || "").startsWith(Tracker.ALARM_PREFIX)) {
        return undefined;
      }
      const id = String(alarm.name).slice(Tracker.ALARM_PREFIX.length);
      return runTracker(id, "alarm").catch((error) => {
        console.error("AnyDownload tracker run failed.", error);
      });
    });
  }

  if (Tracker && browser.notifications && browser.notifications.onClicked) {
    browser.notifications.onClicked.addListener((notificationId) => {
      if (!String(notificationId || "").startsWith("anydownload-tracker:")) {
        return undefined;
      }
      const url = browser.runtime.getURL("tracking/tracking.html");
      return browser.tabs.create({ active: true, url }).then(() =>
        browser.notifications.clear(notificationId).catch(() => undefined)
      ).catch(() => undefined);
    });
  }

  if (Tracker && browser.permissions && browser.permissions.onRemoved) {
    browser.permissions.onRemoved.addListener(() => {
      queueTrackerMutation(async () => {
        const trackers = await loadTrackers();
        const updated = [];
        const paused = [];
        for (const tracker of trackers) {
          const granted = await trackerPermissionGranted(tracker).catch(() => true);
          if (granted) {
            updated.push(tracker);
            continue;
          }
          if (!tracker.enabled && tracker.autoPausedReason === "Site access was removed.") {
            updated.push(tracker);
            continue;
          }
          const now = Date.now();
          const message = "Website access was removed. Open the tracked page in AnyDownload and grant access again.";
          const next = Tracker.normalizeTracker({
            ...tracker,
            enabled: false,
            autoPausedReason: "Site access was removed.",
            lastError: message,
            backoffUntil: 0,
            consecutiveErrors: tracker.consecutiveErrors + 1,
            consecutiveAuthorizationErrors: 0,
            lastRunAt: now,
            lastDurationMs: 0,
            updatedAt: now,
            activity: Tracker.appendActivity(tracker.activity, {
              startedAt: now,
              finishedAt: now,
              durationMs: 0,
              reason: "permission",
              status: "error",
              pagesChecked: 0,
              found: 0,
              queued: 0,
              message
            })
          }, now);
          updated.push(next);
          paused.push(next);
        }
        await saveTrackers(updated);
        return { updated, paused };
      }).then(({ updated, paused }) => Promise.all([
        ...updated.map(syncTrackerAlarm),
        ...paused.map((tracker) => notifyTracker(tracker, "error", `${tracker.pageTitle}: ${tracker.lastError}`))
      ])).catch((error) => {
        console.error("AnyDownload could not reconcile removed tracker permissions.", error);
      });
    });
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
        .then((tab) => openResizableImageWindow(tab, message.collectGallery === true
          ? [1, 3, 10].includes(message.galleryPages) ? message.galleryPages : 10
          : 0))
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => ({
          ok: false,
          error: error && error.message ? error.message : String(error)
        }));
    }

    if (message.type === "SITE_GALLERY") {
      // ponytail: one bounded storage record; split by site if writes contend.
      const operation = galleryMutationQueue.catch(() => undefined).then(async () => {
        if (!Gallery || !["get", "save", "clear"].includes(message.action)) {
          throw new Error("Unknown gallery action.");
        }
        const siteKey = Core.siteKeyForUrl(Gallery.pageUrl(message.siteKey));
        if (!siteKey) {
          throw new Error("A gallery must belong to an HTTP(S) website.");
        }
        const area = message.incognito ? browser.storage.session : browser.storage.local;
        const stored = await area.get(Gallery.STORAGE_KEY);
        const sites = stored[Gallery.STORAGE_KEY];
        if (message.action === "get") {
          return { ok: true, gallery: Gallery.getSite(sites, siteKey) };
        }
        const result = Gallery.updateSites(sites, { ...message, siteKey });
        if (!result.stale) {
          await area.set({ [Gallery.STORAGE_KEY]: result.sites });
        }
        return { ok: true, gallery: result.gallery, stale: result.stale };
      });
      galleryMutationQueue = operation;
      return operation.catch((error) => ({ ok: false, error: error.message || String(error) }));
    }

    if ([
      "GET_TRACKER",
      "GET_TRACKERS",
      "UPSERT_TRACKER",
      "RUN_TRACKER",
      "SET_TRACKER_ENABLED",
      "SET_ALL_TRACKERS_ENABLED",
      "DELETE_TRACKER"
    ].includes(message.type)) {
      return trackerMessage(message).catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : String(error)
      }));
    }

    if (message.type === "TRACKER_REVIEW_ACTION") {
      return trackerReviewAction(message).catch((error) => ({
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
      return getDownloadDashboard(Boolean(message.incognito), {
        summaryOnly: message.summaryOnly === true
      }).catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : String(error)
      }));
    }

    if (message.type === "GET_MEDIA_DOWNLOAD_STATUS") {
      return getMediaDownloadStatuses(message).catch((error) => ({
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
  reconcileTrackerAlarms().catch((error) => {
    console.error("AnyDownload could not restore its tracker schedule.", error);
  });
})();
