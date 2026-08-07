(function initializeDownloadBackground() {
  "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const collectImagesFromPage = globalThis.ImageDownloaderCollector;
  const MAX_CONCURRENCY = 5;
  const MAX_IGNORED_PER_SITE = 500;
  const MAX_IGNORED_RULES = 5000;
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

  function acknowledgeMenuCreation() {
    // Reading lastError prevents duplicate-ID errors from becoming uncaught when
    // a non-persistent background page wakes and the persisted menus still exist.
    void browser.runtime.lastError;
  }

  function createContextMenus() {
    if (!browser.menus || typeof browser.menus.create !== "function") {
      return;
    }
    const common = { contexts: ["image"] };
    const entries = [
      { id: MENU_IDS.root, title: "AnyDownload", ...common },
      {
        id: MENU_IDS.download,
        parentId: MENU_IDS.root,
        title: "Download full-size image",
        ...common
      },
      {
        id: MENU_IDS.preview,
        parentId: MENU_IDS.root,
        title: "Preview full-size image",
        ...common
      },
      {
        id: MENU_IDS.ignore,
        parentId: MENU_IDS.root,
        title: "Ignore image on this site",
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
        title: "Open image list…",
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
      throw new Error("Firefox cannot open the AnyDownload image window.");
    }
    const createProperties = { active: true, url };
    if (Number.isInteger(tab && tab.windowId)) {
      createProperties.windowId = tab.windowId;
    }
    return browser.tabs.create(createProperties);
  }

  function openResizableImageWindow(tab) {
    if (!tab || !Number.isInteger(tab.id)) {
      return Promise.reject(new Error("Firefox did not identify the source tab."));
    }

    const incognito = Boolean(tab.incognito);
    const storageKey = managerWindowStorageKey(incognito);
    const previous = managerWindowQueues.get(storageKey) || Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const url = managerWindowUrl(tab.id);
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

  function normalizedImageUrl(value) {
    const result = Core.validateDownloadUrl(value);
    return result.ok ? result.value : "";
  }

  function safeContextImage(image) {
    const url = normalizedImageUrl(image && image.url);
    if (!url) {
      return null;
    }
    return {
      url,
      previewUrl: normalizedImageUrl(image && image.previewUrl),
      alt: String(image && image.alt || "").slice(0, 500),
      width: Math.max(0, Number(image && image.width) || 0),
      height: Math.max(0, Number(image && image.height) || 0),
      kinds: Array.from(image && image.kinds || [])
        .slice(0, 8)
        .map((kind) => String(kind).slice(0, 50))
    };
  }

  async function resolveContextImage(info, tab) {
    const sourceUrl = normalizedImageUrl(info && info.srcUrl);
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
          .map(safeContextImage)
          .filter(Boolean);
        const exact = discovered.find((image) =>
          sourceUrl && (image.url === sourceUrl || image.previewUrl === sourceUrl)
        );
        if (exact) {
          return exact;
        }
        if (Number.isInteger(info && info.targetElementId) && discovered.length === 1) {
          return discovered[0];
        }
      } catch (_error) {
        // Fall back to Firefox's srcUrl when a protected page/frame blocks injection.
      }
    }
    if (!sourceUrl) {
      throw new Error("Firefox did not expose a downloadable URL for this image.");
    }
    return {
      url: sourceUrl,
      previewUrl: "",
      alt: "",
      width: 0,
      height: 0,
      kinds: ["Context image"]
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
        name: Core.filenameForImage(image.url, 0),
        alt: image.alt,
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
      throw new Error("This image cannot be ignored on this page.");
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
    const stored = await browser.storage.local.get(["destinationFolder", "askForSingle"]);
    const storedFolder = Core.validateFolderPath(stored.destinationFolder);
    const folder = storedFolder.ok ? storedFolder.value : defaultFolderForPage(info, tab);
    const result = await startBatch(validateBatch({
      type: "DOWNLOAD_BATCH",
      folder,
      saveAs: Boolean(stored.askForSingle),
      incognito: Boolean(tab && tab.incognito),
      items: [{ url: image.url }]
    }));
    if (!result.ok) {
      const firstError = result.errors && result.errors[0] && result.errors[0].error;
      throw new Error(firstError || "Firefox could not start this download.");
    }
  }

  async function handleImageMenuClick(info, tab) {
    const image = await resolveContextImage(info, tab);
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

  function finishRetainedDownload(downloadId) {
    const retained = retainedObjectUrls.get(downloadId);
    if (!retained) {
      return;
    }
    retainedObjectUrls.delete(downloadId);
    URL.revokeObjectURL(retained.objectUrl);
    retained.resolve();
  }

  browser.downloads.onChanged.addListener((change) => {
    if (
      change &&
      change.state &&
      ["complete", "interrupted"].includes(change.state.current)
    ) {
      finishRetainedDownload(change.id);
    }
  });

  function dataUrlToObjectUrl(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Malformed embedded image URL.");
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

    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  }

  function retainObjectUrlUntilFinished(downloadId, objectUrl) {
    return new Promise((resolve) => {
      retainedObjectUrls.set(downloadId, { objectUrl, resolve });
      browser.downloads.search({ id: downloadId }).then((matches) => {
        const item = matches[0];
        if (item && ["complete", "interrupted"].includes(item.state)) {
          finishRetainedDownload(downloadId);
        }
      }).catch(() => {
        // The onChanged listener remains the authoritative cleanup path.
      });
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
      throw new Error("Choose at least one image.");
    }

    if (message.items.length > Core.MAX_BATCH_SIZE) {
      throw new Error(`A batch can contain at most ${Core.MAX_BATCH_SIZE} images.`);
    }

    const items = [];
    const validationErrors = [];
    let totalUrlLength = 0;
    message.items.forEach((item, index) => {
      const urlResult = Core.validateDownloadUrl(item && item.url);
      if (!urlResult.ok) {
        validationErrors.push({ index, error: `Image ${index + 1}: ${urlResult.error}` });
        return;
      }
      if (totalUrlLength + urlResult.value.length > Core.MAX_BATCH_TOTAL_URL_LENGTH) {
        validationErrors.push({ index, error: `Image ${index + 1}: the batch URL payload is too large.` });
        return;
      }
      totalUrlLength += urlResult.value.length;
      items.push({ url: urlResult.value, originalIndex: index });
    });

    if (!items.length) {
      throw new Error(validationErrors[0] ? validationErrors[0].error : "No valid image URLs were supplied.");
    }

    return {
      folder: folderResult.value,
      items,
      saveAs: Boolean(message.saveAs) && message.items.length === 1 && items.length === 1,
      incognito: Boolean(message.incognito),
      total: message.items.length,
      validationErrors
    };
  }

  async function startBatch(batch) {
    const usedNames = new Set();
    const entries = batch.items.map((item, index) => {
      const baseName = Core.filenameForImage(item.url, index);
      const filename = Core.uniquifyFilename(baseName, usedNames);
      return {
        url: item.url,
        filename,
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
          const downloadUrl = entry.url.startsWith("data:")
            ? (objectUrl = dataUrlToObjectUrl(entry.url))
            : entry.url;
          const downloadId = await browser.downloads.download({
            url: downloadUrl,
            filename: entry.targetPath,
            conflictAction: "uniquify",
            saveAs: batch.saveAs,
            incognito: batch.incognito
          });
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
      console.error("AnyDownload could not rebuild its image context menu.", error);
    })
  );

  if (browser.menus && browser.menus.onClicked) {
    browser.menus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === MENU_IDS.open) {
        return openResizableImageWindow(tab).then(() => {
          showActionFeedback(tab && tab.id, true);
        }).catch((error) => {
          console.error("AnyDownload could not open its image window.", error);
          showActionFeedback(tab && tab.id, false);
        });
      }
      if (![MENU_IDS.download, MENU_IDS.preview, MENU_IDS.ignore].includes(info.menuItemId)) {
        return undefined;
      }
      return handleImageMenuClick(info, tab).catch((error) => {
        console.error("AnyDownload image action failed.", error);
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
        .then((tab) => openResizableImageWindow(tab))
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => ({
          ok: false,
          error: error && error.message ? error.message : String(error)
        }));
    }

    if (message.type !== "DOWNLOAD_BATCH") {
      return undefined;
    }

    try {
      return startBatch(validateBatch(message));
    } catch (error) {
      return Promise.resolve({
        ok: false,
        total: 0,
        started: 0,
        failed: 0,
        error: error && error.message ? error.message : String(error),
        errors: []
      });
    }
  });
})();
