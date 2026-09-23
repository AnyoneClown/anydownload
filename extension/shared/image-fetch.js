(function attachImageDownloaderImageFetch(root) {
  "use strict";

  const Core = root.ImageDownloaderCore || (typeof module === "object" && module.exports ? require("./core.js") : null);
  const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
  const MAX_IMAGE_BYTES = MAX_MEDIA_BYTES;
  const MESSAGES = Object.freeze({
    cancelled: "Media fetching was cancelled.",
    source_permission: "Grant Firefox access to the original media host, then retry.",
    source_failed: "The original media could not be fetched. Check site access and whether its URL expired; redirected media URLs must be collected from their final host.",
    source_timeout: "The original media request timed out after 2 minutes.",
    image_too_large: "Image is larger than the 64 MiB per-file limit.",
    video_too_large: "Video is larger than the 64 MiB per-file limit.",
    invalid_image: "The source did not contain a supported image.",
    invalid_video: "The source did not contain a supported MP4, WebM, Ogg, MOV, M4V, or MKV video.",
    embedded_image: "Embedded images cannot be saved in upload jobs. Save the image locally and select that file in Upload Progress.",
    embedded_video: "Embedded videos cannot be saved in upload jobs. Save the video locally and select that file in Upload Progress.",
    file_required: "Select the same local media file again to retry. File bytes are not saved with upload jobs."
  });
  function errorMessage(code) { return MESSAGES[code] || MESSAGES.source_failed; }
  function failure(code) { return Object.assign(new Error(errorMessage(code)), { code }); }

  function contentTypeForBytes(bytes) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 32));
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 8 && bytes[0] === 137 && head.slice(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
    if (/^GIF8[79]a/.test(head)) return "image/gif";
    if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
    if (head.startsWith("BM")) return "image/bmp";
    if (head.startsWith("II*\0") || head.startsWith("MM\0*")) return "image/tiff";
    if (head.startsWith("\0\0\x01\0")) return "image/vnd.microsoft.icon";
    if (head.slice(4, 8) === "ftyp") {
      const brands = head.slice(8);
      if (/avif|avis/.test(brands)) return "image/avif";
      if (/heic|heix|hevc|hevx|mif1|msf1/.test(brands)) return "image/heic";
    }
    if (bytes[0] === 0xff && bytes[1] === 0x0a || head.slice(4, 8) === "JXL ") return "image/jxl";
    const text = new TextDecoder().decode(bytes.subarray(0, 4096));
    if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) return "image/svg+xml";
    return "";
  }

  function videoContentTypeForBytes(bytes, hint = "", filename = "") {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
    const claimed = String(hint || "").split(";", 1)[0].trim().toLowerCase();
    const extension = /\.([a-z0-9]+)(?:$|[?#])/i.exec(String(filename || ""))?.[1]?.toLowerCase() || "";
    if (head.startsWith("OggS")) return "video/ogg";
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return extension === "mkv" || claimed === "video/x-matroska" ? "video/x-matroska" : "video/webm";
    }
    if (head.slice(4, 8) === "ftyp") {
      const brands = head.slice(8);
      if (/avif|avis|heic|heix|hevc|hevx|mif1|msf1/.test(brands)) return "";
      if (/qt\s{2}/.test(brands) || extension === "mov" || claimed === "video/quicktime") return "video/quicktime";
      return extension === "m4v" || claimed === "video/x-m4v" ? "video/x-m4v" : "video/mp4";
    }
    return "";
  }

  async function imageBlob(value) {
    if (!(value instanceof Blob) || !value.size) throw failure("invalid_image");
    if (value.size > MAX_IMAGE_BYTES) throw failure("image_too_large");
    const contentType = contentTypeForBytes(new Uint8Array(await value.slice(0, 4096).arrayBuffer()));
    if (!contentType) throw failure("invalid_image");
    return value.type === contentType ? value : value.slice(0, value.size, contentType);
  }

  async function videoBlob(value, filename = "") {
    if (!(value instanceof Blob) || !value.size) throw failure("invalid_video");
    if (value.size > MAX_MEDIA_BYTES) throw failure("video_too_large");
    const contentType = videoContentTypeForBytes(
      new Uint8Array(await value.slice(0, 4096).arrayBuffer()), value.type, filename
    );
    if (!contentType) throw failure("invalid_video");
    return value.type === contentType ? value : value.slice(0, value.size, contentType);
  }

  function mediaBlob(value, mediaType = "image", filename = "") {
    return mediaType === "video" ? videoBlob(value, filename) : imageBlob(value);
  }

  async function fetchMedia(value, mediaType, signal,
    { permissionContains, onProgress = () => undefined } = {}, asBlob = false) {
    if (!["image", "video"].includes(mediaType)) throw failure("source_failed");
    const invalidCode = mediaType === "video" ? "invalid_video" : "invalid_image";
    const tooLargeCode = mediaType === "video" ? "video_too_large" : "image_too_large";
    const embeddedCode = mediaType === "video" ? "embedded_video" : "embedded_image";
    const validated = Core.validateDownloadUrl(value);
    if (!validated.ok) throw failure("source_failed");
    if (validated.value.startsWith("data:")) throw failure(embeddedCode);
    const url = new URL(validated.value);
    if (url.username || url.password) throw failure("source_failed");
    if (signal.aborted) throw failure("cancelled");
    const pattern = `${url.protocol}//${url.hostname}/*`;
    if (typeof permissionContains !== "function" || !await permissionContains(pattern)) throw failure("source_permission");
    if (signal.aborted) throw failure("cancelled");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
    try {
      // Same 64 MiB streaming ceiling as archive/archive.js. Source cookies remain on their original host.
      const response = await root.fetch(url.href, {
        credentials: "include", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal
      });
      if (!response.ok) throw failure("source_failed");
      if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES) throw failure(tooLargeCode);
      const type = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (type && !type.startsWith(`${mediaType}/`) && !["application/octet-stream", "binary/octet-stream"].includes(type)) {
        throw failure(invalidCode);
      }
      if (!response.body || typeof response.body.getReader !== "function") throw failure("source_failed");
      const reader = response.body.getReader();
      const chunks = [];
      const prefix = new Uint8Array(4096);
      let prefixLength = 0;
      let size = 0;
      try {
        while (true) {
          if (controller.signal.aborted) throw failure("cancelled");
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_MEDIA_BYTES) throw failure(tooLargeCode);
          chunks.push(chunk.value);
          if (prefixLength < prefix.length) {
            const length = Math.min(prefix.length - prefixLength, chunk.value.byteLength);
            prefix.set(chunk.value.subarray(0, length), prefixLength);
            prefixLength += length;
          }
          onProgress(size);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!size) throw failure(invalidCode);
      const contentType = mediaType === "video"
        ? videoContentTypeForBytes(prefix.subarray(0, prefixLength), type, url.pathname)
        : contentTypeForBytes(prefix.subarray(0, prefixLength));
      if (!contentType) throw failure(invalidCode);
      if (signal.aborted) throw failure("cancelled");
      if (asBlob) return new Blob(chunks, { type: contentType });
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes, contentType };
    } catch (error) {
      if (signal.aborted) throw failure("cancelled");
      if (timedOut) throw failure("source_timeout");
      throw failure(error && Object.hasOwn(MESSAGES, error.code) ? error.code : "source_failed");
    } finally {
      clearTimeout(timeout);
      controller.abort();
      signal.removeEventListener("abort", cancel);
    }
  }

  function fetchMediaBytes(value, mediaType = "image", signal = new AbortController().signal, options) {
    return fetchMedia(value, mediaType, signal, options, false);
  }

  function fetchMediaBlob(value, mediaType = "image", signal = new AbortController().signal, options) {
    return fetchMedia(value, mediaType, signal, options, true);
  }

  function fetchImageBytes(value, signal, options) {
    return fetchMediaBytes(value, "image", signal, options);
  }

  const api = Object.freeze({ MAX_MEDIA_BYTES, MAX_IMAGE_BYTES, contentTypeForBytes, videoContentTypeForBytes,
    imageBlob, videoBlob, mediaBlob, fetchMediaBytes, fetchMediaBlob, fetchImageBytes, errorMessage });
  root.ImageDownloaderImageFetch = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
