(function attachImageDownloaderArchivePage(root) {
  "use strict";

  const Core = root.ImageDownloaderCore || (
    typeof module === "object" && module.exports
      ? require("../shared/core.js")
      : null
  );
  const StoredZip = root.ImageDownloaderArchive || (
    typeof module === "object" && module.exports
      ? require("../shared/archive.js")
      : null
  );

  const MAX_ARCHIVE_ITEMS = 2000;
  const MAX_ARCHIVE_AGE_MS = 10 * 60 * 1000;
  const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
  const MAX_ARCHIVE_PART_BYTES = 64 * 1024 * 1024;
  const MAX_ARCHIVE_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
  const DOWNLOAD_RETENTION_POLL_MS = 1000;
  const DOWNLOAD_RETENTION_MAX_MS = 24 * 60 * 60 * 1000;
  const MAX_ERROR_REPORT_BYTES = 512 * 1024;
  const ZIP_END_RECORD_BYTES = 22;
  const ZIP_ENTRY_OVERHEAD_BYTES = 76;
  const JOB_ID_PATTERN = /^[a-z0-9-]{8,80}$/i;
  const textEncoder = new TextEncoder();

  class ArchiveCancelledError extends Error {
    constructor() {
      super("Archive creation was cancelled.");
      this.name = "ArchiveCancelledError";
    }
  }

  function requireCore() {
    if (!Core) {
      throw new Error("The AnyDownload validation library is unavailable.");
    }
    return Core;
  }

  function validateJobId(value) {
    return typeof value === "string" && JOB_ID_PATTERN.test(value) ? value : "";
  }

  function validateArchiveRequest(payload, now) {
    const core = requireCore();
    const currentTime = now === undefined ? Date.now() : Number(now);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("This archive request is missing or has already been used.");
    }

    const createdAt = Number(payload.createdAt);
    const age = currentTime - createdAt;
    if (
      !Number.isFinite(currentTime) ||
      !Number.isFinite(createdAt) ||
      age < -60000 ||
      age > MAX_ARCHIVE_AGE_MS
    ) {
      throw new Error("This archive request has expired.");
    }

    const folderResult = core.validateFolderPath(payload.folder);
    if (!folderResult.ok) {
      throw new Error(folderResult.error);
    }
    if (typeof payload.incognito !== "boolean") {
      throw new Error("This archive request has an invalid browsing mode.");
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error("This archive request does not contain any images.");
    }
    if (payload.items.length > MAX_ARCHIVE_ITEMS) {
      throw new Error(`An archive can contain at most ${MAX_ARCHIVE_ITEMS} images.`);
    }

    const items = [];
    let totalUrlLength = 0;
    payload.items.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Image ${index + 1} has an invalid archive entry.`);
      }
      const result = core.validateDownloadUrl(item.url);
      if (!result.ok) {
        throw new Error(`Image ${index + 1}: ${result.error}`);
      }
      totalUrlLength += result.value.length;
      if (totalUrlLength > core.MAX_BATCH_TOTAL_URL_LENGTH) {
        throw new Error("The archive URL payload is too large.");
      }
      const fallbackFilename = core.filenameForImage(result.value, index);
      if (item.filename !== undefined && typeof item.filename !== "string") {
        throw new Error(`Image ${index + 1} has an invalid filename.`);
      }
      const filename = core.sanitizeFilename(item.filename || fallbackFilename, fallbackFilename);
      items.push({ url: result.value, filename, originalIndex: index });
    });

    return {
      createdAt,
      folder: folderResult.value,
      incognito: payload.incognito,
      items
    };
  }

  function utf8Length(value) {
    return textEncoder.encode(String(value)).byteLength;
  }

  function storedZipEntryFootprint(name, dataSize) {
    const size = Number(dataSize);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError("ZIP entry sizes must be non-negative safe integers.");
    }
    const nameBytes = utf8Length(name);
    if (!nameBytes || nameBytes > 0xffff) {
      throw new Error("ZIP entry names must have between 1 and 65535 UTF-8 bytes.");
    }
    return ZIP_ENTRY_OVERHEAD_BYTES + (nameBytes * 2) + size;
  }

  function estimateStoredZipSize(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError("ZIP planning entries must be an array.");
    }
    return entries.reduce(
      (total, entry) => total + storedZipEntryFootprint(entry && entry.name, entry && entry.size),
      ZIP_END_RECORD_BYTES
    );
  }

  function planArchiveParts(entries, maximumPartBytes) {
    if (!Array.isArray(entries)) {
      throw new TypeError("ZIP planning entries must be an array.");
    }
    const limit = maximumPartBytes === undefined
      ? MAX_ARCHIVE_PART_BYTES
      : Number(maximumPartBytes);
    if (!Number.isSafeInteger(limit) || limit < ZIP_END_RECORD_BYTES) {
      throw new TypeError("The ZIP part limit must be a positive safe integer.");
    }

    const parts = [];
    let currentEntries = [];
    let currentSize = ZIP_END_RECORD_BYTES;
    entries.forEach((entry, index) => {
      const contribution = storedZipEntryFootprint(entry && entry.name, entry && entry.size);
      if (ZIP_END_RECORD_BYTES + contribution > limit) {
        throw new Error(`ZIP entry ${index + 1} cannot fit in one archive part.`);
      }
      if (currentEntries.length && currentSize + contribution > limit) {
        parts.push({ entries: currentEntries, size: currentSize });
        currentEntries = [];
        currentSize = ZIP_END_RECORD_BYTES;
      }
      currentEntries.push(entry);
      currentSize += contribution;
    });
    if (currentEntries.length) {
      parts.push({ entries: currentEntries, size: currentSize });
    }
    return parts;
  }

  function archiveFilenameForFolder(folder) {
    const core = requireCore();
    const folderResult = core.validateFolderPath(folder);
    if (!folderResult.ok) {
      throw new Error(folderResult.error);
    }
    const lastSegment = folderResult.value.split("/").pop() || "images";
    const basename = core.sanitizePathSegment(lastSegment.replace(/\.zip$/i, ""), "images");
    return core.sanitizeFilename(`${truncateArchiveStem(basename, 4)}.zip`, "images.zip");
  }

  function truncateArchiveStem(value, reservedLength) {
    const maximum = Math.max(1, 100 - Math.max(0, Number(reservedLength) || 0));
    const text = String(value || "images");
    if (text.length <= maximum) {
      return text;
    }
    let truncated = text.slice(0, maximum);
    if (/[\ud800-\udbff]$/.test(truncated)) {
      truncated = truncated.slice(0, -1);
    }
    return truncated || "images";
  }

  function archivePartFilename(baseFilename, partNumber, multipart) {
    const core = requireCore();
    const baseStem = core.sanitizePathSegment(
      String(baseFilename || "").replace(/\.zip$/i, ""),
      "images"
    );
    if (!multipart) {
      return core.sanitizeFilename(`${truncateArchiveStem(baseStem, 4)}.zip`, "images.zip");
    }
    const number = Number(partNumber);
    if (!Number.isSafeInteger(number) || number < 1 || number > 999999) {
      throw new Error("Archive part numbers must be positive integers.");
    }
    const suffix = `-part-${String(number).padStart(3, "0")}.zip`;
    const stem = truncateArchiveStem(baseStem, suffix.length);
    return core.sanitizeFilename(
      `${stem}${suffix}`,
      `images-part-${String(number).padStart(3, "0")}.zip`
    );
  }

  function normalizedContentType(value) {
    return String(value || "").split(";", 1)[0].trim().toLowerCase();
  }

  function isClearlyNonImageContentType(value) {
    const contentType = normalizedContentType(value);
    return Boolean(
      contentType &&
      !contentType.startsWith("image/") &&
      !["application/octet-stream", "binary/octet-stream"].includes(contentType)
    );
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) {
      return `${Math.round(bytes).toLocaleString()} B`;
    }
    const units = ["KiB", "MiB", "GiB"];
    let amount = bytes;
    let unit = "B";
    for (const candidate of units) {
      amount /= 1024;
      unit = candidate;
      if (amount < 1024 || candidate === units[units.length - 1]) {
        break;
      }
    }
    const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toLocaleString(undefined, { maximumFractionDigits: digits })} ${unit}`;
  }

  function truncateMiddle(value, maximumLength) {
    const text = String(value || "");
    if (text.length <= maximumLength) {
      return text;
    }
    const leftLength = Math.ceil((maximumLength - 1) / 2);
    return `${text.slice(0, leftLength)}…${text.slice(-(maximumLength - leftLength - 1))}`;
  }

  function archiveErrorReport(failures) {
    const safeFailures = Array.isArray(failures) ? failures : [];
    const lines = [
      "AnyDownload could not archive the following images:",
      ""
    ];
    let encodedSize = utf8Length(`${lines.join("\n")}\n`);
    let included = 0;

    for (let index = 0; index < safeFailures.length; index += 1) {
      const failure = safeFailures[index] || {};
      const number = Number.isInteger(failure.index) ? failure.index + 1 : index + 1;
      const filename = truncateMiddle(failure.filename, 180);
      const url = truncateMiddle(failure.url, 520);
      const reason = truncateMiddle(failure.error || "Unknown error", 420);
      const line = [
        `Image ${number}${filename ? ` (${filename})` : ""}: ${reason}`,
        url ? `URL: ${url}` : ""
      ].filter(Boolean).join("\n");
      const lineSize = utf8Length(`${line}\n\n`);
      if (encodedSize + lineSize > MAX_ERROR_REPORT_BYTES - 100) {
        break;
      }
      lines.push(line, "");
      encodedSize += lineSize;
      included += 1;
    }

    if (included < safeFailures.length) {
      lines.push(`${safeFailures.length - included} additional failure(s) were omitted to keep this report small.`);
    }
    return textEncoder.encode(`${lines.join("\n")}\n`);
  }

  function decodeDataImageUrl(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Malformed embedded image URL.");
    }
    const header = dataUrl.slice(5, commaIndex);
    const payload = dataUrl.slice(commaIndex + 1);
    const contentType = normalizedContentType(header.split(";", 1)[0]);
    let bytes;
    if (/;base64(?:;|$)/i.test(header)) {
      let binary;
      try {
        binary = atob(payload.replace(/\s/g, ""));
      } catch (_error) {
        throw new Error("Malformed base64 image data.");
      }
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
    } else {
      try {
        bytes = textEncoder.encode(decodeURIComponent(payload));
      } catch (_error) {
        throw new Error("Malformed embedded image data.");
      }
    }
    if (!contentType.startsWith("image/")) {
      throw new Error("Embedded data is not an image.");
    }
    if (bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error("Image is larger than the 64 MiB per-file limit.");
    }
    if (!bytes.byteLength) {
      throw new Error("Image response was empty.");
    }
    return { bytes, contentType };
  }

  function contentLengthForResponse(response) {
    const length = Number(response && response.headers && response.headers.get("content-length"));
    return Number.isFinite(length) && length > 0 ? length : 0;
  }

  async function readResponseBytes(response, declaredLength, signal, onProgress) {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      let allocated = declaredLength ? new Uint8Array(declaredLength) : null;
      let chunks = allocated ? null : [];
      let size = 0;
      try {
        while (true) {
          if (signal.aborted) {
            throw new ArchiveCancelledError();
          }
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
            throw new Error("Image is larger than the 64 MiB per-file limit.");
          }
          if (allocated && nextSize <= allocated.byteLength) {
            allocated.set(chunk, size);
          } else {
            if (allocated) {
              chunks = [allocated.subarray(0, size)];
              allocated = null;
            }
            chunks.push(chunk);
          }
          size = nextSize;
          onProgress(size);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }

      if (!size) {
        throw new Error("Image response was empty.");
      }
      if (allocated) {
        return size === allocated.byteLength ? allocated : allocated.slice(0, size);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    const buffer = await response.arrayBuffer();
    if (signal.aborted) {
      throw new ArchiveCancelledError();
    }
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error("Image is larger than the 64 MiB per-file limit.");
    }
    if (!bytes.byteLength) {
      throw new Error("Image response was empty.");
    }
    onProgress(bytes.byteLength);
    return bytes;
  }

  async function fetchImageBytes(url, jobSignal, onProgress) {
    if (jobSignal.aborted) {
      throw new ArchiveCancelledError();
    }
    if (url.startsWith("data:")) {
      const decoded = decodeDataImageUrl(url);
      onProgress(decoded.bytes.byteLength);
      return decoded;
    }

    const controller = new AbortController();
    let timedOut = false;
    const forwardCancellation = () => controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MAX_ARCHIVE_FETCH_TIMEOUT_MS);
    jobSignal.addEventListener("abort", forwardCancellation, { once: true });
    try {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response || !response.ok) {
        const status = Number(response && response.status) || 0;
        const statusText = String(response && response.statusText || "").trim();
        throw new Error(status
          ? `HTTP ${status}${statusText ? ` ${statusText}` : ""}`
          : "Image request failed.");
      }

      const contentType = normalizedContentType(response.headers && response.headers.get("content-type"));
      if (isClearlyNonImageContentType(contentType)) {
        throw new Error(`Server returned ${contentType} instead of an image.`);
      }
      const declaredLength = contentLengthForResponse(response);
      if (declaredLength > MAX_ARCHIVE_ENTRY_BYTES) {
        throw new Error("Image is larger than the 64 MiB per-file limit.");
      }
      const bytes = await readResponseBytes(response, declaredLength, controller.signal, onProgress);
      return { bytes, contentType };
    } catch (error) {
      if (jobSignal.aborted) {
        throw new ArchiveCancelledError();
      }
      if (timedOut) {
        throw new Error("Image request timed out after 2 minutes.");
      }
      if (error && error.name === "AbortError") {
        throw new Error("Image request was aborted.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      jobSignal.removeEventListener("abort", forwardCancellation);
    }
  }

  function waitForDownloadTerminal(downloadsApi, downloadId, signal, options) {
    return new Promise((resolve) => {
      const settings = options || {};
      const pollIntervalMs = Number.isFinite(settings.pollIntervalMs)
        ? Math.max(0, Number(settings.pollIntervalMs))
        : DOWNLOAD_RETENTION_POLL_MS;
      const maximumWaitMs = Number.isFinite(settings.maximumWaitMs)
        ? Math.max(0, Number(settings.maximumWaitMs))
        : DOWNLOAD_RETENTION_MAX_MS;
      const startedAt = Date.now();
      let settled = false;
      let pollTimer = null;

      function finish(state, error) {
        if (settled) {
          return;
        }
        settled = true;
        if (pollTimer !== null) {
          clearTimeout(pollTimer);
        }
        downloadsApi.onChanged.removeListener(onChanged);
        signal.removeEventListener("abort", cancelDownload);
        resolve({ state, error: String(error || "") });
      }

      function onChanged(change) {
        if (!change || change.id !== downloadId || !change.state) {
          return;
        }
        if (["complete", "interrupted"].includes(change.state.current)) {
          finish(change.state.current, change.error && change.error.current);
        }
      }

      function cancelDownload() {
        if (typeof downloadsApi.cancel === "function") {
          try {
            Promise.resolve(downloadsApi.cancel(downloadId)).catch(() => undefined);
          } catch (_error) {
            // Settling below still releases the page even if Firefox rejects cancel().
          }
        }
        finish("interrupted", "Cancelled by user.");
      }

      async function poll() {
        if (settled) {
          return;
        }
        try {
          const matches = await downloadsApi.search({ id: downloadId });
          const item = matches && matches[0];
          if (item && ["complete", "interrupted"].includes(item.state)) {
            finish(item.state, item.error);
            return;
          }
        } catch (_error) {
          // downloads.onChanged can still provide the terminal state.
        }
        if (Date.now() - startedAt >= maximumWaitMs) {
          finish(
            "interrupted",
            "AnyDownload stopped waiting for Firefox after 24 hours."
          );
          return;
        }
        if (!settled) {
          pollTimer = setTimeout(poll, pollIntervalMs);
        }
      }

      downloadsApi.onChanged.addListener(onChanged);
      signal.addEventListener("abort", cancelDownload, { once: true });
      if (signal.aborted) {
        cancelDownload();
      }
      poll();
    });
  }

  function elementMap(documentObject) {
    const ids = [
      "byte-count",
      "cancel-button",
      "current-item",
      "destination-label",
      "downloads-empty",
      "downloads-list",
      "failure-count",
      "failures-empty",
      "failures-list",
      "fatal-message",
      "fatal-panel",
      "fetched-count",
      "job-progress",
      "job-summary",
      "progress-description",
      "progress-panel",
      "show-downloads-button",
      "status-heading",
      "total-count"
    ];
    const elements = {};
    ids.forEach((id) => {
      const element = documentObject.getElementById(id);
      if (!element) {
        throw new Error(`Archive Progress is missing the ${id} control.`);
      }
      elements[id] = element;
    });
    return elements;
  }

  function appendFailureRow(documentObject, elements, failure) {
    elements["failures-empty"].hidden = true;
    const item = documentObject.createElement("li");
    item.className = "result-item interrupted";
    const copy = documentObject.createElement("div");
    copy.className = "result-copy";
    const title = documentObject.createElement("strong");
    title.textContent = `Image ${failure.index + 1}: ${failure.filename}`;
    const reason = documentObject.createElement("span");
    reason.textContent = failure.error;
    const url = documentObject.createElement("span");
    url.textContent = truncateMiddle(failure.url, 800);
    url.title = failure.url;
    copy.append(title, reason, url);
    item.append(copy);
    elements["failures-list"].append(item);
  }

  function createDownloadRow(documentObject, elements, filename, size) {
    elements["downloads-empty"].hidden = true;
    const item = documentObject.createElement("li");
    item.className = "result-item";
    const copy = documentObject.createElement("div");
    copy.className = "result-copy";
    const title = documentObject.createElement("strong");
    title.textContent = filename;
    const status = documentObject.createElement("span");
    status.textContent = `Starting ${formatBytes(size)} download…`;
    copy.append(title, status);
    item.append(copy);
    elements["downloads-list"].append(item);
    return { item, status };
  }

  async function initializeArchivePage(options) {
    const settings = options || {};
    const browserObject = settings.browser || root.browser;
    const documentObject = settings.document || root.document;
    const locationObject = settings.location || root.location;
    if (!browserObject || !documentObject || !locationObject) {
      throw new Error("Archive Progress requires a Firefox extension page.");
    }
    const elements = elementMap(documentObject);
    const maximumPartBytes = settings.maximumPartBytes === undefined
      ? MAX_ARCHIVE_PART_BYTES
      : Number(settings.maximumPartBytes);
    if (!Number.isSafeInteger(maximumPartBytes) || maximumPartBytes < ZIP_END_RECORD_BYTES) {
      throw new Error("The archive part limit must be a positive safe integer.");
    }
    const controller = new AbortController();
    const state = {
      activeObjectUrls: new Set(),
      currentDownloadId: null,
      failures: [],
      fetched: 0,
      imageBytes: 0,
      interruptedDownloads: 0,
      processed: 0,
      savedParts: 0,
      total: 0,
      lastBytePaint: 0
    };

    function setStatus(title, description) {
      elements["status-heading"].textContent = title;
      elements["progress-description"].textContent = description || "";
    }

    function updateProgress(currentLoaded) {
      const activeBytes = Math.max(0, Number(currentLoaded) || 0);
      elements["fetched-count"].textContent = state.fetched.toLocaleString();
      elements["failure-count"].textContent = state.failures.length.toLocaleString();
      elements["byte-count"].textContent = formatBytes(state.imageBytes + activeBytes);
      elements["job-progress"].max = Math.max(1, state.total);
      elements["job-progress"].value = Math.min(state.processed, state.total);
    }

    function showFatal(message) {
      elements["fatal-message"].textContent = message;
      elements["fatal-panel"].hidden = false;
      elements["cancel-button"].hidden = true;
      elements["current-item"].textContent = "Stopped";
      setStatus("Archive stopped", message);
    }

    function addFailure(candidate, error) {
      const failure = {
        index: candidate.originalIndex,
        filename: candidate.filename,
        url: candidate.url,
        error: error && error.message ? error.message : String(error)
      };
      state.failures.push(failure);
      state.processed += 1;
      appendFailureRow(documentObject, elements, failure);
      updateProgress(0);
    }

    function throwIfCancelled() {
      if (controller.signal.aborted) {
        throw new ArchiveCancelledError();
      }
    }

    async function downloadZipBlob(blob, targetPath, displayName) {
      const row = createDownloadRow(documentObject, elements, displayName, blob.size);
      const objectUrl = URL.createObjectURL(blob);
      state.activeObjectUrls.add(objectUrl);
      let downloadId = null;
      try {
        downloadId = await browserObject.downloads.download({
          url: objectUrl,
          filename: targetPath,
          conflictAction: "uniquify",
          saveAs: false,
          incognito: Boolean(request.incognito)
        });
        if (!Number.isInteger(downloadId)) {
          throw new Error("Firefox did not start this archive download.");
        }
        state.currentDownloadId = downloadId;
        elements["show-downloads-button"].hidden = false;
        if (controller.signal.aborted && typeof browserObject.downloads.cancel === "function") {
          await browserObject.downloads.cancel(downloadId).catch(() => undefined);
        }
        const terminal = await waitForDownloadTerminal(
          browserObject.downloads,
          downloadId,
          controller.signal
        );
        row.item.classList.add(terminal.state);
        if (terminal.state === "complete") {
          state.savedParts += 1;
          row.status.textContent = `Saved ${formatBytes(blob.size)} to Downloads/${targetPath}`;
          const showButton = documentObject.createElement("button");
          showButton.className = "show-file-button";
          showButton.type = "button";
          showButton.textContent = "Show";
          showButton.addEventListener("click", () => {
            if (typeof browserObject.downloads.show === "function") {
              browserObject.downloads.show(downloadId).catch(() => undefined);
            }
          });
          row.item.append(showButton);
        } else {
          state.interruptedDownloads += 1;
          row.status.textContent = `Interrupted${terminal.error ? `: ${terminal.error}` : "."}`;
        }
      } catch (error) {
        state.interruptedDownloads += 1;
        row.item.classList.add("interrupted");
        row.status.textContent = `Could not save: ${error && error.message ? error.message : String(error)}`;
      } finally {
        state.currentDownloadId = null;
        state.activeObjectUrls.delete(objectUrl);
        URL.revokeObjectURL(objectUrl);
      }
    }

    async function finalizePart(entries, partNumber, multipart, baseFilename) {
      throwIfCancelled();
      const displayName = archivePartFilename(baseFilename, partNumber, multipart);
      elements["current-item"].textContent = `Building ${displayName}`;
      setStatus("Building archive", `Creating ${displayName} locally…`);
      const zip = StoredZip.createStoredZip(entries, { date: new Date() });
      if (!zip || !Array.isArray(zip.parts) || zip.size > maximumPartBytes) {
        throw new Error("An archive part exceeded the 64 MiB safety limit.");
      }
      const blob = new Blob(zip.parts, { type: "application/zip" });
      zip.parts.length = 0;
      for (const entry of entries) {
        entry.data = null;
      }
      entries.length = 0;
      const targetPath = requireCore().buildDownloadPath(request.folder, displayName);
      elements["current-item"].textContent = `Saving ${displayName}`;
      setStatus("Saving archive", `Waiting for Firefox to finish ${displayName}…`);
      await downloadZipBlob(blob, targetPath, displayName);
      throwIfCancelled();
    }

    async function processRequest() {
      if (!StoredZip || typeof StoredZip.createStoredZip !== "function") {
        throw new Error("The local ZIP builder is unavailable.");
      }
      const usedNames = new Set();
      const candidates = request.items.map((item) => ({
        ...item,
        filename: requireCore().uniquifyFilename(
          item.filename || requireCore().filenameForImage(item.url, item.originalIndex),
          usedNames
        )
      }));
      const baseFilename = archiveFilenameForFolder(request.folder);
      let currentEntries = [];
      let currentSize = ZIP_END_RECORD_BYTES;
      let multipart = false;
      let partNumber = 1;

      for (let index = 0; index < candidates.length; index += 1) {
        throwIfCancelled();
        const candidate = candidates[index];
        elements["current-item"].textContent = `Image ${index + 1} of ${state.total} — ${candidate.filename}`;
        setStatus("Fetching original images", `Processing image ${index + 1} of ${state.total}…`);
        let fetched;
        try {
          fetched = await fetchImageBytes(candidate.url, controller.signal, (loaded) => {
            const now = Date.now();
            if (now - state.lastBytePaint > 80) {
              state.lastBytePaint = now;
              updateProgress(loaded);
            }
          });
        } catch (error) {
          if (error instanceof ArchiveCancelledError || controller.signal.aborted) {
            throw new ArchiveCancelledError();
          }
          addFailure(candidate, error);
          continue;
        }

        throwIfCancelled();
        const contribution = storedZipEntryFootprint(candidate.filename, fetched.bytes.byteLength);
        if (ZIP_END_RECORD_BYTES + contribution > maximumPartBytes) {
          addFailure(candidate, new Error("Image cannot fit into a 64 MiB ZIP part."));
          fetched = null;
          continue;
        }
        if (currentEntries.length && currentSize + contribution > maximumPartBytes) {
          multipart = true;
          await finalizePart(currentEntries, partNumber, true, baseFilename);
          partNumber += 1;
          currentEntries = [];
          currentSize = ZIP_END_RECORD_BYTES;
        }
        currentEntries.push({ name: candidate.filename, data: fetched.bytes });
        currentSize += contribution;
        state.fetched += 1;
        state.processed += 1;
        state.imageBytes += fetched.bytes.byteLength;
        fetched = null;
        updateProgress(0);
      }

      if (!state.fetched) {
        currentEntries.length = 0;
        throw new Error("None of the selected images could be fetched. Review the failures below for details.");
      }

      if (state.failures.length) {
        const report = archiveErrorReport(state.failures);
        const reportContribution = storedZipEntryFootprint("anydownload-errors.txt", report.byteLength);
        if (currentEntries.length && currentSize + reportContribution > maximumPartBytes) {
          multipart = true;
          await finalizePart(currentEntries, partNumber, true, baseFilename);
          partNumber += 1;
          currentEntries = [];
          currentSize = ZIP_END_RECORD_BYTES;
        }
        currentEntries.push({ name: "anydownload-errors.txt", data: report });
        currentSize += reportContribution;
      }

      if (currentEntries.length) {
        await finalizePart(currentEntries, partNumber, multipart, baseFilename);
      }

      elements["current-item"].textContent = "None";
      elements["cancel-button"].hidden = true;
      elements["job-progress"].value = state.total;
      if (state.interruptedDownloads) {
        setStatus(
          "Finished with download errors",
          `Fetched ${state.fetched} image${state.fetched === 1 ? "" : "s"}; Firefox interrupted ${state.interruptedDownloads} archive download${state.interruptedDownloads === 1 ? "" : "s"}.`
        );
      } else if (state.failures.length) {
        setStatus(
          "Archive complete with skipped images",
          `Saved ${state.fetched} image${state.fetched === 1 ? "" : "s"}; ${state.failures.length} failure${state.failures.length === 1 ? " is" : "s are"} listed below and in anydownload-errors.txt.`
        );
      } else {
        setStatus(
          "Archive complete",
          `Saved all ${state.fetched.toLocaleString()} selected images.`
        );
      }
    }

    let request;
    let storageKey = "";
    elements["cancel-button"].addEventListener("click", () => {
      if (controller.signal.aborted) {
        return;
      }
      elements["cancel-button"].disabled = true;
      setStatus("Cancelling…", "Stopping the active request and discarding the unfinished part.");
      controller.abort();
      if (Number.isInteger(state.currentDownloadId) && typeof browserObject.downloads.cancel === "function") {
        browserObject.downloads.cancel(state.currentDownloadId).catch(() => undefined);
      }
    });
    elements["show-downloads-button"].addEventListener("click", () => {
      if (typeof browserObject.downloads.showDefaultFolder === "function") {
        browserObject.downloads.showDefaultFolder();
      }
    });

    const unload = () => {
      controller.abort();
      if (Number.isInteger(state.currentDownloadId) && typeof browserObject.downloads.cancel === "function") {
        browserObject.downloads.cancel(state.currentDownloadId).catch(() => undefined);
      }
      for (const objectUrl of state.activeObjectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
      state.activeObjectUrls.clear();
    };
    const windowObject = settings.window || root;
    if (windowObject && typeof windowObject.addEventListener === "function") {
      windowObject.addEventListener("beforeunload", unload, { once: true });
    }

    try {
      const params = new URLSearchParams(locationObject.search);
      const jobId = validateJobId(params.get("job") || "");
      if (!jobId) {
        throw new Error("This Archive Progress link is invalid.");
      }
      storageKey = `archiveJobRequest:${jobId}`;
      const stored = await browserObject.storage.session.get(storageKey);
      await browserObject.storage.session.remove(storageKey);
      request = validateArchiveRequest(stored && stored[storageKey]);
      state.total = request.items.length;
      elements["total-count"].textContent = state.total.toLocaleString();
      elements["destination-label"].textContent = `Downloads/${request.folder}`;
      elements["destination-label"].title = `Downloads/${request.folder}`;
      elements["job-summary"].textContent = `${state.total.toLocaleString()} selected image${state.total === 1 ? "" : "s"} → Downloads/${request.folder}`;
      documentObject.title = `${state.total} images — AnyDownload Archive Progress`;
      elements["cancel-button"].disabled = false;
      updateProgress(0);
      await processRequest();
    } catch (error) {
      if (error instanceof ArchiveCancelledError || controller.signal.aborted) {
        elements["cancel-button"].hidden = true;
        elements["current-item"].textContent = "Cancelled";
        setStatus(
          "Archive cancelled",
          state.savedParts
            ? "Previously completed archive parts remain in Downloads; the unfinished part was discarded."
            : "No unfinished archive was saved."
        );
      } else {
        showFatal(error && error.message ? error.message : String(error));
      }
    } finally {
      if (storageKey) {
        await browserObject.storage.session.remove(storageKey).catch(() => undefined);
      }
      request = null;
    }
  }

  const api = Object.freeze({
    MAX_ARCHIVE_AGE_MS,
    MAX_ARCHIVE_ENTRY_BYTES,
    MAX_ARCHIVE_ITEMS,
    MAX_ARCHIVE_PART_BYTES,
    archiveErrorReport,
    archiveFilenameForFolder,
    archivePartFilename,
    estimateStoredZipSize,
    formatBytes,
    initializeArchivePage,
    isClearlyNonImageContentType,
    planArchiveParts,
    storedZipEntryFootprint,
    validateArchiveRequest,
    validateJobId,
    waitForDownloadTerminal
  });

  root.ImageDownloaderArchivePage = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.document && root.browser && root.location) {
    const start = () => {
      initializeArchivePage().catch((error) => {
        console.error("Archive Progress failed to initialize", error);
      });
    };
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})(typeof globalThis === "object" ? globalThis : this);
