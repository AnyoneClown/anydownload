(function initializePopup() {
  "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const MAX_DISCOVERED_IMAGES = Core.MAX_BATCH_SIZE;
  const MAX_SCANNED_ELEMENTS = 10000;
  const MAX_RENDERED_ROWS = 350;

  const state = {
    images: [],
    selected: new Set(),
    scanWarnings: [],
    busy: false,
    hasStoredFolder: false,
    incognito: false
  };

  const elements = {};
  let thumbnailObserver = null;

  function collectImagesFromPage(options) {
    const settings = Object.assign(
      {
        includeBackgrounds: true,
        maxImages: 1500,
        maxElements: 10000,
        maxDataUrlLength: 500000,
        maxPayloadLength: 2000000
      },
      options || {}
    );
    const found = new Map();
    const warnings = [];
    let truncated = false;
    let payloadLimitReached = false;
    let skippedLargeDataUrls = 0;
    let skippedBlobUrls = 0;
    let skippedLongUrls = 0;
    let totalUrlLength = 0;

    function safeText(value, maxLength) {
      return String(value == null ? "" : value).slice(0, maxLength);
    }

    function normalizeUrl(rawValue) {
      if (typeof rawValue !== "string") {
        return "";
      }
      const value = rawValue.trim();
      if (!value) {
        return "";
      }
      if (value.startsWith("data:")) {
        if (!/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) {
          return "";
        }
        if (value.length > settings.maxDataUrlLength) {
          skippedLargeDataUrls += 1;
          return "";
        }
        return value;
      }
      if (value.length > 16384) {
        skippedLongUrls += 1;
        return "";
      }

      try {
        const parsed = new URL(value, document.baseURI);
        if (parsed.protocol === "blob:") {
          skippedBlobUrls += 1;
          return "";
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return "";
        }
        parsed.hash = "";
        return parsed.href;
      } catch (_error) {
        return "";
      }
    }

    function addImage(rawUrl, details) {
      const url = normalizeUrl(rawUrl);
      if (!url) {
        return;
      }

      const existing = found.get(url);
      if (existing) {
        if (details.kind && !existing.kinds.includes(details.kind)) {
          existing.kinds.push(details.kind);
        }
        existing.width = Math.max(existing.width || 0, details.width || 0);
        existing.height = Math.max(existing.height || 0, details.height || 0);
        existing.alt = existing.alt || safeText(details.alt, 500);
        return;
      }

      if (found.size >= settings.maxImages) {
        truncated = true;
        return;
      }
      if (totalUrlLength + url.length > settings.maxPayloadLength) {
        payloadLimitReached = true;
        return;
      }

      totalUrlLength += url.length;
      found.set(url, {
        url,
        alt: safeText(details.alt, 500),
        width: Number(details.width) || 0,
        height: Number(details.height) || 0,
        kinds: [details.kind || "Page image"]
      });
    }

    function addBestSrcset(srcset, details) {
      if (!srcset || typeof srcset !== "string") {
        return;
      }
      const candidates = srcset.slice(0, 200000)
        .split(/,\s+(?=(?:[^()]|\([^)]*\))*$)/)
        .map((candidate) => candidate.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (candidates.length) {
        addImage(candidates[candidates.length - 1], details);
      }
    }

    function cssUrls(value) {
      const urls = [];
      const pattern = /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi;
      const boundedValue = String(value || "").slice(0, 200000);
      let match;
      while ((match = pattern.exec(boundedValue))) {
        urls.push((match[2] || match[3] || "").trim());
      }
      return urls;
    }

    const roots = [document];
    const allElements = [];
    let elementLimitReached = false;
    for (let rootIndex = 0; rootIndex < roots.length && allElements.length < settings.maxElements; rootIndex += 1) {
      try {
        const walker = document.createTreeWalker(roots[rootIndex], NodeFilter.SHOW_ELEMENT);
        let element;
        while ((element = walker.nextNode())) {
          if (allElements.length >= settings.maxElements) {
            elementLimitReached = true;
            break;
          }
          allElements.push(element);
          if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
            roots.push(element.shadowRoot);
          }
        }
      } catch (_error) {
        // Detached or browser-owned roots can disappear while being walked.
      }
      if (elementLimitReached) {
        break;
      }
    }
    if (elementLimitReached) {
      warnings.push(`Only the first ${settings.maxElements.toLocaleString()} page elements were scanned.`);
    }

    let embeddedFrameCount = 0;
    for (const element of allElements) {
      const tagName = String(element.localName || "").toLowerCase();
      if (tagName === "iframe" || tagName === "frame") {
        embeddedFrameCount += 1;
      }
      if (tagName === "img") {
        const currentUrl = element.currentSrc || element.src || element.getAttribute("src");
        const lazyAttributes = ["data-src", "data-lazy-src", "data-original", "data-url"];
        const lazyUrls = lazyAttributes.map((name) => element.getAttribute(name)).filter(Boolean);
        const looksLikePlaceholder =
          String(currentUrl || "").startsWith("data:") &&
          (Number(element.naturalWidth) || 0) <= 2 &&
          (Number(element.naturalHeight) || 0) <= 2;

        if (!looksLikePlaceholder || lazyUrls.length === 0) {
          addImage(currentUrl, {
            kind: "Image",
            alt: element.alt,
            width: element.naturalWidth,
            height: element.naturalHeight
          });
        }

        for (const lazyUrl of lazyUrls) {
          addImage(lazyUrl, {
            kind: "Lazy image",
            alt: element.alt,
            width: element.naturalWidth,
            height: element.naturalHeight
          });
        }
        addBestSrcset(element.getAttribute("data-srcset"), {
          kind: "Lazy image",
          alt: element.alt,
          width: element.naturalWidth,
          height: element.naturalHeight
        });
      } else if (tagName === "image" && element.namespaceURI === "http://www.w3.org/2000/svg") {
        const href = element.href && element.href.baseVal ? element.href.baseVal : element.getAttribute("href") || element.getAttribute("xlink:href");
        addImage(href, {
          kind: "SVG image",
          alt: element.getAttribute("aria-label") || "",
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height
        });
      } else if (tagName === "input" && String(element.type).toLowerCase() === "image") {
        addImage(element.src || element.getAttribute("src"), {
          kind: "Image input",
          alt: element.alt,
          width: element.width,
          height: element.height
        });
      } else if (tagName === "video" && element.poster) {
        addImage(element.poster, {
          kind: "Video poster",
          alt: element.getAttribute("aria-label") || "",
          width: element.videoWidth,
          height: element.videoHeight
        });
      }

      if (settings.includeBackgrounds && !truncated && !payloadLimitReached) {
        try {
          const style = getComputedStyle(element);
          const values = [
            style.backgroundImage,
            style.borderImageSource,
            style.listStyleImage,
            style.maskImage,
            style.webkitMaskImage
          ];
          for (const value of values) {
            for (const url of cssUrls(value)) {
              addImage(url, {
                kind: "CSS image",
                alt: element.getAttribute("aria-label") || "",
                width: element.clientWidth,
                height: element.clientHeight
              });
            }
          }
        } catch (_error) {
          // Some browser-owned or detached nodes do not expose computed styles.
        }
      }
    }

    if (truncated) {
      warnings.push(`The scan reached its safety limit of ${settings.maxImages.toLocaleString()} distinct images.`);
    }
    if (payloadLimitReached) {
      warnings.push("Some images were skipped because their combined URL data exceeded the 2 MB safety limit.");
    }
    if (skippedLargeDataUrls) {
      warnings.push(`${skippedLargeDataUrls} very large embedded image${skippedLargeDataUrls === 1 ? " was" : "s were"} skipped.`);
    }
    if (skippedBlobUrls) {
      warnings.push(`${skippedBlobUrls} page-owned blob image${skippedBlobUrls === 1 ? " was" : "s were"} skipped because Firefox cannot download it from an extension.`);
    }
    if (skippedLongUrls) {
      warnings.push(`${skippedLongUrls} unusually long image URL${skippedLongUrls === 1 ? " was" : "s were"} skipped.`);
    }
    if (document.querySelector("canvas")) {
      warnings.push("Canvas pixels are not downloadable as source images.");
    }

    return {
      pageUrl: safeText(location.href, 16384),
      pageTitle: safeText(document.title, 300),
      embeddedFrameCount,
      images: Array.from(found.values()),
      warnings
    };
  }

  function cacheElements() {
    const ids = [
      "action-detail",
      "ask-single-input",
      "backgrounds-input",
      "download-button",
      "filter-input",
      "folder-help",
      "folder-input",
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
          byUrl.set(normalizedUrl, {
            url: normalizedUrl,
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
    if (!query) {
      return state.images;
    }
    return state.images.filter((image) => {
      const haystack = `${image.url} ${image.alt || ""} ${(image.kinds || []).join(" ")}`.toLocaleLowerCase();
      return haystack.includes(query);
    });
  }

  function friendlyFilename(image) {
    const index = Math.max(0, state.images.indexOf(image));
    return Core.filenameForImage(image.url, index);
  }

  function updateSummary() {
    const total = state.images.length;
    const selected = state.selected.size;
    const visible = filteredImages();
    const hasFilter = Boolean(elements["filter-input"].value.trim());
    const folder = folderStatus();
    elements["summary-label"].textContent = hasFilter
      ? `${visible.length.toLocaleString()} of ${total.toLocaleString()} images shown`
      : `${total.toLocaleString()} image${total === 1 ? "" : "s"}`;
    elements["select-all-button"].textContent = hasFilter ? "Select matches only" : "Select all";
    elements["select-none-button"].textContent = hasFilter ? "Clear matches" : "Clear";
    elements["selected-label"].textContent = `${selected.toLocaleString()} selected`;
    elements["action-detail"].textContent = selected
      ? `Ready for Downloads/${folder.ok ? folder.value : "…"}`
      : "Choose images to download";
    elements["download-button"].textContent = selected === 1 ? "Download image" : "Download selected";
    elements["download-button"].disabled = state.busy || selected === 0 || !folder.ok;
    elements["rescan-button"].disabled = state.busy;
  }

  function makeImageRow(image) {
    const row = document.createElement("article");
    row.className = "image-row";

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

    const thumbnailFrame = document.createElement("div");
    thumbnailFrame.className = "thumbnail-frame";
    const thumbnail = document.createElement("img");
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.referrerPolicy = "no-referrer";
    thumbnail.dataset.src = image.url;
    thumbnail.addEventListener("error", () => thumbnail.classList.add("broken"));
    if (thumbnailObserver) {
      thumbnailObserver.observe(thumbnail);
    } else {
      thumbnail.src = image.url;
    }
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
    const dimensions = image.width && image.height ? `${Math.round(image.width)} × ${Math.round(image.height)}` : "size unknown";
    meta.textContent = `${dimensions} · ${(image.kinds || ["Image"]).join(", ")}`;
    copy.append(name, url, meta);

    const download = document.createElement("button");
    download.type = "button";
    download.className = "row-download-button";
    download.textContent = "Save";
    download.title = "Download only this image";
    download.disabled = state.busy;
    download.addEventListener("click", () => requestDownloads([image]));

    row.append(checkbox, thumbnailFrame, copy, download);
    return row;
  }

  function renderImages() {
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }
    thumbnailObserver = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.target.dataset.src) {
              entry.target.src = entry.target.dataset.src;
              delete entry.target.dataset.src;
              thumbnailObserver.unobserve(entry.target);
            }
          }
        }, { root: elements["image-list"], rootMargin: "100px" })
      : null;
    elements["image-list"].replaceChildren();
    const visible = filteredImages();
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = state.images.length
        ? "No images match this filter."
        : "No downloadable images were found in the loaded page.";
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
      note.textContent = `Showing the first ${MAX_RENDERED_ROWS.toLocaleString()} matches. All ${visible.length.toLocaleString()} remain available for bulk selection.`;
      elements["image-list"].appendChild(note);
    }
    updateSummary();
  }

  async function scanPage() {
    state.busy = true;
    state.images = [];
    state.selected.clear();
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

      state.images = merged.images;
      state.selected = new Set(merged.images.map((image) => image.url));
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
    if (state.busy || !images.length) {
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
      await browser.storage.local.set({
        destinationFolder: folder.value,
        askForSingle: elements["ask-single-input"].checked,
        includeBackgrounds: elements["backgrounds-input"].checked
      });
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
        await browser.storage.local.set({ destinationFolder: folder.value });
      }
      updateSummary();
    });
    elements["ask-single-input"].addEventListener("change", () => {
      browser.storage.local.set({ askForSingle: elements["ask-single-input"].checked });
    });
    elements["backgrounds-input"].addEventListener("change", () => {
      browser.storage.local.set({ includeBackgrounds: elements["backgrounds-input"].checked });
    });
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
      const images = state.images.filter((image) => state.selected.has(image.url));
      requestDownloads(images);
    });
  }

  async function initialize() {
    cacheElements();
    wireEvents();
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
