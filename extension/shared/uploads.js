(function attachImageDownloaderUploads(root) {
  "use strict";

  const Core = root.ImageDownloaderCore || (typeof module === "object" && module.exports ? require("./core.js") : null);
  const Immich = root.ImageDownloaderImmich || (typeof module === "object" && module.exports ? require("./immich.js") : null);
  const ImageFetch = root.ImageDownloaderImageFetch || (typeof module === "object" && module.exports ? require("./image-fetch.js") : null);
  const MAX_ITEMS = 500;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ID = /^[a-z0-9_-]{1,128}$/i;
  const UPLOAD_STATUSES = Object.freeze(["pending", "fetching", "uploading", "complete", "failed", "uncertain", "cancelled"]);
  const ALBUM_STATUSES = Object.freeze(["none", "pending", "attaching", "complete", "failed"]);
  const JOB_STATUSES = Object.freeze(["queued", "running", "complete", "partial", "cancelled", "interrupted"]);
  const LOCAL_MESSAGES = Object.freeze({
    invalid_job: "The upload request is invalid. Create a new upload from the media manager.",
    wrong_connection: "This upload belongs to a different account or server. Reconnect the original destination to retry.",
    checkpoint_failed: "Upload progress could not be saved. Work stopped; any unconfirmed request requires an explicit retry.",
    interrupted: "This upload was interrupted. Retry unfinished media explicitly; transfers do not resume their bytes.",
    uncertain: "Immich may have received this media file, but its result was not confirmed. Retry explicitly; Immich detects duplicate bytes.",
    failed: "The operation failed. Check the source, connection, and permissions, then retry."
  });
  const PROVIDER_CODES = new Set(["invalid_server", "invalid_key", "missing_upload_permission", "missing_album_permission", "forbidden",
    "unreachable", "timeout", "cancelled", "unsupported_api", "invalid_response", "server_error", "rejected", "album_failed", "invalid_asset"]);
  const MEDIA_CODES = new Set(["source_permission", "source_failed", "source_timeout", "image_too_large", "video_too_large",
    "invalid_image", "invalid_video", "embedded_image", "embedded_video", "file_required"]);
  function errorMessage(code) {
    return LOCAL_MESSAGES[code] || (MEDIA_CODES.has(code) ? ImageFetch.errorMessage(code) :
      PROVIDER_CODES.has(code) ? Immich.errorMessage(code) : LOCAL_MESSAGES.failed);
  }
  function safeCode(value) {
    return Object.hasOwn(LOCAL_MESSAGES, value) || PROVIDER_CODES.has(value) || MEDIA_CODES.has(value) ? value : "failed";
  }
  function failure(code) { return Object.assign(new Error(errorMessage(code)), { code: safeCode(code) }); }
  function timestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() < 0) throw failure("invalid_job");
    return date.toISOString();
  }
  function complete(item) { return item.uploadStatus === "complete" && ["none", "complete"].includes(item.albumStatus); }

  function createJob(items, options = {}) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS || options.incognito === true ||
        typeof options.ownerId !== "string" || !ID.test(options.ownerId) ||
        typeof options.connectionId !== "string" || !UUID.test(options.connectionId) || options.provider && options.provider !== "immich" ||
        options.albumId && !UUID.test(options.albumId)) throw failure("invalid_job");
    const id = options.id || root.crypto.randomUUID();
    if (typeof id !== "string" || !ID.test(id)) throw failure("invalid_job");
    const createdAt = timestamp(options.createdAt === undefined ? Date.now() : options.createdAt);
    const serverUrl = Immich.normalizeServerUrl(options.serverUrl);
    const albumId = options.albumId || null;
    let totalUrlLength = 0;
    const normalized = items.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw failure("invalid_job");
      const indicatedType = String(item.mimeType || item.type || item.file && item.file.type || "");
      const indicatedName = String(item.filename || item.file && item.file.name || item.url || "");
      const inferredVideo = /^video\//i.test(indicatedType) || /\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)(?:$|[?#])/i.test(indicatedName);
      const mediaType = item.mediaType === undefined ? inferredVideo ? "video" : "image" : item.mediaType;
      if (!["image", "video"].includes(mediaType)) throw failure("invalid_job");
      const invalidCode = mediaType === "video" ? "invalid_video" : "invalid_image";
      const tooLargeCode = mediaType === "video" ? "video_too_large" : "image_too_large";
      const embeddedCode = mediaType === "video" ? "embedded_video" : "embedded_image";
      const source = item.source === "file" || item.file instanceof Blob ? "file" : "url";
      let url = null;
      let size = null;
      let lastModified = null;
      if (source === "url") {
        const checked = Core.validateDownloadUrl(item.url);
        if (!checked.ok) throw failure("invalid_job");
        if (checked.value.startsWith("data:")) throw failure(embeddedCode);
        const parsed = new URL(checked.value);
        if (parsed.username || parsed.password) throw failure("invalid_job");
        if (mediaType === "image" && (/\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)$/i.test(parsed.pathname) ||
            /^video\//i.test(indicatedType))) throw failure("invalid_image");
        url = checked.value;
        totalUrlLength += url.length;
        if (totalUrlLength > Core.MAX_BATCH_TOTAL_URL_LENGTH) throw failure("invalid_job");
      } else {
        size = item.file ? item.file.size : item.size;
        lastModified = item.file ? item.file.lastModified : item.lastModified;
        if (!Number.isSafeInteger(size) || size <= 0) throw failure(invalidCode);
        if (size > ImageFetch.MAX_MEDIA_BYTES) throw failure(tooLargeCode);
        if (!Number.isSafeInteger(lastModified) || lastModified < 0) throw failure("invalid_job");
      }
      const fallback = url
        ? (Core.filenameForMedia || Core.filenameForImage)(url, index, mediaType)
        : `${mediaType}-${index + 1}`;
      if (item.filename !== undefined && typeof item.filename !== "string") throw failure("invalid_job");
      const filename = Core.sanitizeFilename(item.filename || item.file && item.file.name || fallback, fallback);
      if (mediaType === "image" && /\.(?:m4v|mkv|mov|mp4|ogg|ogv|webm)$/i.test(filename)) throw failure("invalid_image");
      return { id: `${id}-${index}`, source, url, filename, mediaType, size, lastModified,
        deviceAssetId: `${id}-${index}`, createdAt: source === "file" ? timestamp(lastModified) : createdAt,
        uploadStatus: "pending", albumStatus: albumId ? "pending" : "none", assetId: null, duplicate: false, errorCode: "" };
    });
    return { schemaVersion: 1, id, provider: "immich", ownerId: options.ownerId, connectionId: options.connectionId,
      serverUrl, albumId, createdAt, updatedAt: createdAt, status: "queued", items: normalized };
  }

  function recoverJob(input) {
    if (!input || input.schemaVersion !== 1 || !JOB_STATUSES.includes(input.status)) throw failure("invalid_job");
    // Reconstruct an allowlist; keys, binary data, arbitrary errors, and unknown properties cannot enter stored jobs.
    const job = createJob(input.items, input);
    job.updatedAt = timestamp(input.updatedAt);
    job.status = input.status;
    job.items.forEach((item, index) => {
      const old = input.items[index];
      if (!UPLOAD_STATUSES.includes(old.uploadStatus) || !ALBUM_STATUSES.includes(old.albumStatus) ||
          old.assetId && !UUID.test(old.assetId) || old.uploadStatus === "complete" && !old.assetId ||
          old.albumStatus === "complete" && (!old.assetId || !job.albumId) ||
          job.albumId && old.albumStatus === "none") throw failure("invalid_job");
      item.assetId = old.assetId || null;
      item.duplicate = Boolean(old.duplicate);
      item.uploadStatus = item.assetId ? "complete" : old.uploadStatus;
      item.albumStatus = job.albumId ? old.albumStatus : "none";
      item.errorCode = old.errorCode ? safeCode(old.errorCode) : "";
      if (item.uploadStatus === "uploading") { item.uploadStatus = "uncertain"; item.errorCode = "uncertain"; }
      if (item.uploadStatus === "fetching") { item.uploadStatus = "pending"; item.errorCode = "interrupted"; }
      if (item.albumStatus === "attaching") { item.albumStatus = "pending"; item.errorCode = "interrupted"; }
    });
    if (job.items.every(complete)) job.status = "complete";
    else if (["running", "complete"].includes(job.status)) job.status = "interrupted";
    return job;
  }

  function summarize(job) {
    const items = job.items;
    return {
      total: items.length, complete: items.filter(complete).length,
      uploaded: items.filter((item) => item.uploadStatus === "complete").length,
      attached: items.filter((item) => item.albumStatus === "complete").length,
      failed: items.filter((item) => item.uploadStatus === "failed" || item.albumStatus === "failed").length,
      uncertain: items.filter((item) => item.uploadStatus === "uncertain").length,
      cancelled: items.filter((item) => item.uploadStatus === "cancelled").length,
      pending: items.filter((item) => !complete(item) && !["failed", "uncertain", "cancelled"].includes(item.uploadStatus) && item.albumStatus !== "failed").length
    };
  }

  async function run(job, { credential, signal = new AbortController().signal, onChange, fetchImage, provider = Immich } = {}) {
    const normalized = recoverJob(job);
    if (!credential || Immich.normalizeServerUrl(credential.serverUrl) !== normalized.serverUrl ||
        credential.ownerId && credential.ownerId !== normalized.ownerId ||
        credential.connectionId && credential.connectionId !== normalized.connectionId) throw failure("wrong_connection");
    if (typeof onChange !== "function" || typeof fetchImage !== "function") throw failure("invalid_job");
    // Credentials stay on the call stack, separate from the job object passed to persistence and rendering.
    Object.keys(job).forEach((key) => delete job[key]);
    Object.assign(job, normalized);
    async function checkpoint(item, durable = true) {
      job.updatedAt = new Date().toISOString();
      try { await onChange(job, item || null, durable); } catch (_error) { throw failure("checkpoint_failed"); }
    }
    job.status = "running";
    await checkpoint();
    try {
      for (const item of job.items) {
        if (complete(item)) continue;
        if (signal.aborted) break;
        item.errorCode = "";
        if (!item.assetId) {
          item.uploadStatus = "fetching";
          // Fetching cannot mutate Immich; show progress without rewriting the saved job.
          await checkpoint(item, false);
          let blob;
          try {
            const fetched = await fetchImage(item, signal);
            if (item.source === "file" && (!(fetched instanceof Blob) || fetched.size !== item.size ||
                fetched.lastModified !== item.lastModified || Core.sanitizeFilename(fetched.name, "media") !== item.filename)) {
              throw failure("file_required");
            }
            blob = await ImageFetch.mediaBlob(fetched instanceof Blob ? fetched :
              fetched && fetched.bytes instanceof Uint8Array ? new Blob([fetched.bytes], { type: fetched.contentType || "" }) : null,
            item.mediaType, item.filename);
            if (signal.aborted) throw failure("cancelled");
          } catch (error) {
            item.uploadStatus = signal.aborted ? "cancelled" : "failed";
            item.errorCode = signal.aborted ? "cancelled" : safeCode(error && error.code);
            await checkpoint(item);
            if (signal.aborted) break;
            continue;
          }
          item.uploadStatus = "uploading";
          await checkpoint(item);
          try {
            const result = await provider.uploadAsset(credential, { blob, filename: item.filename,
              deviceAssetId: item.deviceAssetId, createdAt: item.createdAt }, { signal });
            if (!result || !UUID.test(result.assetId)) throw Object.assign(failure("invalid_response"), { uncertain: true });
            item.assetId = result.assetId;
            item.duplicate = Boolean(result.duplicate);
            item.uploadStatus = "complete";
          } catch (error) {
            const uncertain = error && typeof error.uncertain === "boolean" ? error.uncertain : true;
            item.uploadStatus = uncertain ? "uncertain" : signal.aborted ? "cancelled" : "failed";
            item.errorCode = uncertain ? "uncertain" : safeCode(error && error.code);
          } finally { blob = null; }
          // Do not attempt an album request until the returned asset identity is durable.
          await checkpoint(item);
        }
        if (signal.aborted) break;
        if (item.assetId && job.albumId && item.albumStatus !== "complete") {
          item.albumStatus = "attaching";
          await checkpoint(item);
          try {
            await provider.addToAlbum(credential, job.albumId, item.assetId, { signal });
            item.albumStatus = "complete";
            item.errorCode = "";
          } catch (error) {
            item.albumStatus = "failed";
            item.errorCode = signal.aborted ? "cancelled" : safeCode(error && error.code || "album_failed");
          }
          await checkpoint(item);
        }
      }
      job.status = job.items.every(complete) ? "complete" : signal.aborted ? "cancelled" : "partial";
      await checkpoint();
      return job;
    } catch (_error) {
      job.status = "interrupted";
      throw failure("checkpoint_failed");
    }
  }

  const api = Object.freeze({ MAX_ITEMS, UPLOAD_STATUSES, ALBUM_STATUSES, JOB_STATUSES, createJob, recoverJob, summarize, run, errorMessage });
  root.ImageDownloaderUploads = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
