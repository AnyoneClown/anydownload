(function attachImageDownloaderImageFetch(root) {
  "use strict";

  const Core = root.ImageDownloaderCore || (typeof module === "object" && module.exports ? require("./core.js") : null);
  const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
  const MESSAGES = Object.freeze({
    cancelled: "Image fetching was cancelled.",
    source_permission: "Grant Firefox access to the original image host, then retry.",
    source_failed: "The original image could not be fetched. Check site access and whether its URL expired; redirected image URLs must be collected from their final host.",
    source_timeout: "The original image request timed out after 2 minutes.",
    image_too_large: "Image is larger than the 64 MiB per-file limit.",
    invalid_image: "The source did not contain a supported image.",
    embedded_image: "Embedded images cannot be saved in upload jobs. Save the image locally and select that file in Upload Progress.",
    file_required: "Select the same local image file again to retry. File bytes are not saved with upload jobs."
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

  async function imageBlob(value) {
    if (!(value instanceof Blob) || !value.size) throw failure("invalid_image");
    if (value.size > MAX_IMAGE_BYTES) throw failure("image_too_large");
    const contentType = contentTypeForBytes(new Uint8Array(await value.slice(0, 4096).arrayBuffer()));
    if (!contentType) throw failure("invalid_image");
    return value.type === contentType ? value : value.slice(0, value.size, contentType);
  }

  async function fetchImageBytes(value, signal = new AbortController().signal, { permissionContains, onProgress = () => undefined } = {}) {
    const validated = Core.validateDownloadUrl(value);
    if (!validated.ok) throw failure("source_failed");
    if (validated.value.startsWith("data:")) throw failure("embedded_image");
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
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw failure("image_too_large");
      const type = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (type && !type.startsWith("image/") && !["application/octet-stream", "binary/octet-stream"].includes(type)) throw failure("invalid_image");
      if (!response.body || typeof response.body.getReader !== "function") throw failure("source_failed");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          if (controller.signal.aborted) throw failure("cancelled");
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw failure("image_too_large");
          chunks.push(chunk.value);
          onProgress(size);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!size) throw failure("invalid_image");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const contentType = contentTypeForBytes(bytes);
      if (!contentType) throw failure("invalid_image");
      if (signal.aborted) throw failure("cancelled");
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

  const api = Object.freeze({ MAX_IMAGE_BYTES, contentTypeForBytes, imageBlob, fetchImageBytes, errorMessage });
  root.ImageDownloaderImageFetch = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
