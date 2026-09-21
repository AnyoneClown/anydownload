(function initializePreview() {
  "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const MAX_PREVIEW_AGE_MS = 5 * 60 * 1000;
  const elements = {
    error: document.getElementById("error-message"),
    image: document.getElementById("preview-image"),
    imageButton: document.getElementById("image-button"),
    loading: document.getElementById("loading-message"),
    meta: document.getElementById("image-meta"),
    name: document.getElementById("image-name"),
    original: document.getElementById("original-link"),
    source: document.getElementById("source-link"),
    stage: document.getElementById("preview-stage"),
    footer: document.getElementById("preview-footer"),
    video: document.getElementById("preview-video")
  };

  function showError(message) {
    elements.loading.hidden = true;
    elements.imageButton.hidden = true;
    elements.video.hidden = true;
    elements.error.textContent = message;
    elements.error.hidden = false;
    elements.meta.textContent = "Preview unavailable";
  }

  function formatDuration(value) {
    if (!Number.isFinite(value) || value < 0) {
      return "";
    }

    const totalSeconds = Math.round(value);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function videoErrorMessage() {
    const error = elements.video.error;
    if (!error) {
      return "Firefox could not load this video. Its URL may have expired or require website-specific access.";
    }

    // MediaError is not exposed as a constructor in every extension-page
    // environment, but its standardized numeric codes are stable.
    if (error.code === 1) {
      return "Video loading was interrupted. Try opening the preview again.";
    }
    if (error.code === 2) {
      return "Firefox could not load this video because of a network error or an expired URL.";
    }
    if (error.code === 3) {
      return "Firefox could not play this video. The file may be damaged or use an unsupported codec.";
    }
    return "Firefox could not play this video. Its format may be unsupported or the URL may require website-specific access.";
  }

  function showImage(urlResult, name, alt) {
    elements.image.alt = alt;
    elements.image.addEventListener("load", () => {
      elements.loading.hidden = true;
      elements.imageButton.disabled = false;
      elements.meta.textContent = `${elements.image.naturalWidth.toLocaleString()} × ${elements.image.naturalHeight.toLocaleString()} pixels`;
    }, { once: true });
    elements.image.addEventListener("error", () => {
      showError("Firefox could not load this image. Its URL may have expired or require a website-specific referrer.");
    }, { once: true });
    elements.image.src = urlResult.value;
  }

  function showVideo(urlResult, payload, validateUrl) {
    elements.stage.classList.add("video-mode");
    elements.imageButton.hidden = true;
    elements.video.hidden = false;
    elements.video.setAttribute("aria-label", payload.alt || payload.name || "Video preview");
    elements.loading.textContent = "Loading video…";
    elements.footer.textContent = "Use the video controls to play, pause, seek, adjust volume, or enter fullscreen.";

    const posterResult = payload.previewUrl ? validateUrl(payload.previewUrl) : null;
    if (posterResult && posterResult.ok) {
      elements.video.poster = posterResult.value;
    }

    elements.video.addEventListener("loadedmetadata", () => {
      elements.loading.hidden = true;
      const details = [];
      if (elements.video.videoWidth > 0 && elements.video.videoHeight > 0) {
        details.push(`${elements.video.videoWidth.toLocaleString()} × ${elements.video.videoHeight.toLocaleString()} pixels`);
      }
      const duration = formatDuration(elements.video.duration);
      if (duration) {
        details.push(`Duration ${duration}`);
      }
      elements.meta.textContent = details.join(" • ") || "Video ready";
    }, { once: true });
    elements.video.addEventListener("error", () => {
      showError(videoErrorMessage());
    }, { once: true });
    elements.video.src = urlResult.value;
  }

  async function loadPreview() {
    const params = new URLSearchParams(location.search);
    const id = params.get("id") || "";
    if (!/^[a-z0-9-]{8,80}$/i.test(id)) {
      throw new Error("This preview link is invalid or expired.");
    }

    const key = `imagePreview:${id}`;
    const area = browser.storage.session;
    const stored = await area.get(key);
    let cached;
    try {
      cached = JSON.parse(sessionStorage.getItem("imagePreview"));
    } catch (_error) {
      // Storage may be unavailable; the original session payload still works.
    }
    const payload = stored[key] || (cached && cached.id === id ? cached.payload : null);
    const validateUrl = typeof Core.validateMediaUrl === "function"
      ? Core.validateMediaUrl
      : Core.validateDownloadUrl;
    let urlResult = validateUrl(payload && payload.url);
    const sourceResult = validateUrl(payload && payload.sourceUrl);
    if (sourceResult.ok && /^https:\/\/web\.telegram\.org\//.test(payload.sourceUrl)) sourceResult.value = payload.sourceUrl;
    if (sourceResult.ok && /^https?:/i.test(sourceResult.value)) {
      elements.source.href = sourceResult.value;
      elements.source.hidden = false;
      if (Number.isSafeInteger(payload.sourceTabId) && payload.sourceTabId >= 0) {
        elements.source.addEventListener("click", async (event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
          }
          event.preventDefault();
          try {
            const tab = await browser.tabs.get(payload.sourceTabId);
            if (tab && tab.url === sourceResult.value) {
              await browser.tabs.update(payload.sourceTabId, { active: true });
            } else {
              location.assign(sourceResult.value);
            }
          } catch (_error) {
            location.assign(sourceResult.value);
          }
        });
      }
    }
    const createdAt = Number(payload && payload.createdAt);
    const age = Date.now() - createdAt;
    if (
      !payload ||
      !urlResult.ok ||
      !Number.isFinite(createdAt) ||
      age < -60000 ||
      age > MAX_PREVIEW_AGE_MS
    ) {
      await area.remove(key);
      try { sessionStorage.removeItem("imagePreview"); } catch (_error) { /* Storage may be unavailable. */ }
      throw new Error("This preview has expired. Return to the page and open it again.");
    }

    // One payload per tab survives reload, expires after five minutes, and is
    // discarded when the tab closes; do not retain it in shared session storage.
    try { sessionStorage.setItem("imagePreview", JSON.stringify({ id, payload })); } catch (_error) { /* Preview still opens. */ }
    await area.remove(key);

    const mediaType = String(payload.mediaType || "image").toLowerCase() === "video"
      ? "video"
      : "image";
    const typeLabel = mediaType === "video" ? "Video" : "Image";
    const name = String(payload.name || `${typeLabel} preview`).slice(0, 180);
    const alt = String(payload.alt || name).slice(0, 500);
    elements.name.textContent = name;
    document.title = `${name} — ${typeLabel} preview`;

    const telegram = globalThis.AnyDownloadTelegram;
    if (telegram && telegram.isMediaUrl(urlResult.value)) {
      elements.loading.textContent = "Loading original media from Telegram…";
      const controller = new AbortController();
      let objectUrl = "";
      addEventListener("pagehide", () => {
        controller.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }, { once: true });
      const blob = await telegram.transfer(browser, {
        url: urlResult.value, source: payload.sourceUrl, mediaType, filename: name
      }, Boolean(payload.incognito), globalThis.ImageDownloaderImageFetch.mediaBlob, controller.signal);
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      urlResult = { ok: true, value: objectUrl };
    }

    if (/^https?:/i.test(urlResult.value)) {
      elements.original.href = urlResult.value;
      elements.original.hidden = false;
    }

    if (mediaType === "video") {
      showVideo(urlResult, { ...payload, name, alt }, validateUrl);
    } else {
      showImage(urlResult, name, alt);
    }
  }

  elements.imageButton.addEventListener("click", () => {
    const actualSize = elements.stage.classList.toggle("actual-size");
    elements.imageButton.setAttribute("aria-pressed", String(actualSize));
  });

  loadPreview().catch((error) => {
    showError(error && error.message ? error.message : String(error));
  });
})();
