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
    stage: document.getElementById("preview-stage")
  };

  function showError(message) {
    elements.loading.hidden = true;
    elements.imageButton.hidden = true;
    elements.error.textContent = message;
    elements.error.hidden = false;
    elements.meta.textContent = "Preview unavailable";
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
    await area.remove(key);
    const payload = stored[key];
    const urlResult = Core.validateDownloadUrl(payload && payload.url);
    const createdAt = Number(payload && payload.createdAt);
    const age = Date.now() - createdAt;
    if (
      !payload ||
      !urlResult.ok ||
      !Number.isFinite(createdAt) ||
      age < -60000 ||
      age > MAX_PREVIEW_AGE_MS
    ) {
      throw new Error("This preview has expired. Return to the page and open it again.");
    }

    const name = String(payload.name || "Image preview").slice(0, 180);
    elements.name.textContent = name;
    elements.image.alt = String(payload.alt || name).slice(0, 500);
    document.title = `${name} — Image preview`;

    if (/^https?:/i.test(urlResult.value)) {
      elements.original.href = urlResult.value;
      elements.original.hidden = false;
    }

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

  elements.imageButton.addEventListener("click", () => {
    const actualSize = elements.stage.classList.toggle("actual-size");
    elements.imageButton.setAttribute("aria-pressed", String(actualSize));
  });

  loadPreview().catch((error) => {
    showError(error && error.message ? error.message : String(error));
  });
})();
