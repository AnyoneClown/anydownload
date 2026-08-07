(function initializeDownloadBackground() {
  "use strict";

  const Core = globalThis.ImageDownloaderCore;
  const MAX_CONCURRENCY = 5;
  const retainedObjectUrls = new Map();

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

  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "DOWNLOAD_BATCH") {
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
