(function attachImageDownloaderCore(root) {
  "use strict";

  const DEFAULT_FOLDER = "Website media";
  const MAX_BATCH_SIZE = 1500;
  const MAX_BATCH_TOTAL_URL_LENGTH = 2000000;
  const MAX_HTTP_URL_LENGTH = 16384;
  const MAX_DATA_URL_LENGTH = 500000;
  const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const UNSAFE_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
  const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
  const IMAGE_EXTENSIONS = new Set([
    "apng",
    "avif",
    "bmp",
    "gif",
    "ico",
    "jpeg",
    "jpg",
    "jxl",
    "png",
    "svg",
    "tif",
    "tiff",
    "webp"
  ]);
  const VIDEO_EXTENSIONS = new Set([
    "m4v",
    "mkv",
    "mov",
    "mp4",
    "ogg",
    "ogv",
    "webm"
  ]);
  const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
  const MIME_EXTENSIONS = {
    "image/apng": "apng",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/tiff": "tiff",
    "image/vnd.microsoft.icon": "ico",
    "image/webp": "webp",
    "application/mp4": "mp4",
    "application/ogg": "ogv",
    "application/webm": "webm",
    "application/x-matroska": "mkv",
    "video/m4v": "m4v",
    "video/mp4": "mp4",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-m4v": "m4v",
    "video/x-matroska": "mkv",
    "video/x-quicktime": "mov"
  };

  function normalizeText(value) {
    const text = String(value == null ? "" : value);
    return typeof text.normalize === "function" ? text.normalize("NFKC") : text;
  }

  function truncateWithoutSplittingSurrogate(value, maximum) {
    const text = String(value || "");
    if (text.length <= maximum) {
      return text;
    }
    let truncated = text.slice(0, maximum);
    const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
    const nextCodeUnit = text.charCodeAt(truncated.length);
    if (
      lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
    ) {
      truncated = truncated.slice(0, -1);
    }
    return truncated;
  }

  function cleanPathSegment(value) {
    let safe = normalizeText(value)
      .replace(BIDI_CONTROLS, "")
      .replace(UNSAFE_FILENAME_CHARACTERS, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[. ]+|[. ]+$/g, "");

    if (RESERVED_WINDOWS_NAME.test(safe)) {
      safe = `_${safe}`;
    }

    return safe;
  }

  function sanitizePathSegment(value, fallback) {
    const safe = truncateWithoutSplittingSurrogate(cleanPathSegment(value), 100)
      .replace(/[. ]+$/g, "");
    return safe || fallback || "";
  }

  function validateFolderPath(input) {
    const value = normalizeText(input).trim();
    if (!value) {
      return { ok: false, error: "Enter a folder name." };
    }

    if (/^(?:[a-z]:[\\/]|[\\/]|~[\\/])/i.test(value)) {
      return {
        ok: false,
        error: "Use a path relative to Firefox's Downloads folder, not an absolute path."
      };
    }

    const rawParts = value.split(/[\\/]+/);
    if (rawParts.some((part) => part === "." || part === "..")) {
      return { ok: false, error: "Folder paths cannot contain . or .. components." };
    }

    if (rawParts.length > 8) {
      return { ok: false, error: "Use at most 8 nested folders." };
    }

    const parts = rawParts
      .map((part) => sanitizePathSegment(part, ""))
      .filter(Boolean);
    const folder = parts.join("/");

    if (!folder) {
      return { ok: false, error: "Enter a valid folder name." };
    }

    if (folder.length > 240) {
      return { ok: false, error: "The folder path is too long." };
    }

    return { ok: true, value: folder, changed: folder !== value.replace(/\\/g, "/") };
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }

  function mediaExtensionFromMime(mime) {
    return MIME_EXTENSIONS[String(mime || "").toLowerCase()] || "";
  }

  function recognizedExtension(filename, mediaType) {
    const match = String(filename || "").match(/\.([a-z0-9]{2,5})$/i);
    if (!match) {
      return "";
    }
    const extension = match[1].toLowerCase();
    const extensions = mediaType === "image"
      ? IMAGE_EXTENSIONS
      : mediaType === "video"
        ? VIDEO_EXTENSIONS
        : MEDIA_EXTENSIONS;
    return extensions.has(extension) ? extension : "";
  }

  function extensionFromDataUrl(url, mediaType) {
    const match = String(url || "").match(/^data:([^;,]+)/i);
    const extension = match ? mediaExtensionFromMime(match[1]) : "";
    if (!extension) {
      return "";
    }
    const extensions = mediaType === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
    return extensions.has(extension) ? extension : "";
  }

  function queryFilename(urlObject, mediaType) {
    const keys = ["filename", "file", "name", "download"];
    for (const key of keys) {
      const candidate = urlObject.searchParams.get(key);
      if (candidate && recognizedExtension(candidate, mediaType)) {
        return candidate;
      }
    }
    return "";
  }

  function queryMediaExtension(urlObject, mediaType) {
    const format = (urlObject.searchParams.get("format") || urlObject.searchParams.get("fm") || "")
      .toLowerCase();
    const extension = mediaExtensionFromMime(format) || format.replace(/^(?:image|video)\//, "");
    const extensions = mediaType === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
    return extensions.has(extension) ? extension : "";
  }

  function sanitizeFilename(value, fallback) {
    let safe = cleanPathSegment(value);
    if (!safe) {
      safe = cleanPathSegment(fallback || "image") || "image";
    }

    const extensionName = recognizedExtension(safe);
    const extension = extensionName
      ? safe.slice(-(extensionName.length + 1))
      : "";
    const stem = extension ? safe.slice(0, -extension.length) : safe;
    const maximumStemLength = Math.max(1, 100 - extension.length);
    const truncatedStem = truncateWithoutSplittingSurrogate(stem, maximumStemLength)
      .replace(/[. ]+$/g, "");
    const candidate = `${truncatedStem || "image"}${extension}`;
    return truncateWithoutSplittingSurrogate(candidate, 100).replace(/[. ]+$/g, "") || "image";
  }

  function filenameForMedia(url, index, mediaType) {
    const normalizedMediaType = String(mediaType || "").toLowerCase() === "video"
      ? "video"
      : "image";
    const sequence = String(Number(index) + 1).padStart(4, "0");
    const fallbackBase = `${normalizedMediaType}-${sequence}`;
    let rawName = "";
    let inferredExtension = "";

    if (String(url).startsWith("data:")) {
      inferredExtension = extensionFromDataUrl(url, normalizedMediaType);
    } else {
      try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split("/").filter(Boolean);
        rawName = safeDecode(pathParts[pathParts.length - 1] || "");
        rawName = queryFilename(parsed, normalizedMediaType) || rawName;
        inferredExtension = queryMediaExtension(parsed, normalizedMediaType);
      } catch (_error) {
        rawName = "";
      }
    }

    rawName = rawName || fallbackBase;
    if (!recognizedExtension(rawName, normalizedMediaType) && inferredExtension) {
      rawName = `${rawName}.${inferredExtension}`;
    } else if (!recognizedExtension(rawName, normalizedMediaType)) {
      // Do not preserve an executable or otherwise misleading extension merely
      // because a page placed that URL in a media-related attribute.
      rawName = rawName.replace(/\./g, "_");
    }

    return sanitizeFilename(rawName, fallbackBase);
  }

  function filenameForImage(url, index) {
    return filenameForMedia(url, index, "image");
  }

  function uniquifyFilename(filename, usedNames) {
    const safeFilename = sanitizeFilename(filename, "image");
    const lowerName = safeFilename.toLocaleLowerCase("en-US");
    if (!usedNames.has(lowerName)) {
      usedNames.add(lowerName);
      return safeFilename;
    }

    const extensionName = recognizedExtension(safeFilename);
    const extension = extensionName
      ? safeFilename.slice(-(extensionName.length + 1))
      : "";
    const stem = extension ? safeFilename.slice(0, -extension.length) : safeFilename;
    let suffix = 2;
    let candidate = "";

    do {
      const suffixText = `-${suffix}`;
      const maximumStemLength = Math.max(1, 100 - suffixText.length - extension.length);
      candidate = sanitizeFilename(
        `${truncateWithoutSplittingSurrogate(stem, maximumStemLength)}${suffixText}${extension}`,
        `image${suffixText}${extension}`
      );
      suffix += 1;
    } while (usedNames.has(candidate.toLocaleLowerCase("en-US")));

    usedNames.add(candidate.toLocaleLowerCase("en-US"));
    return candidate;
  }

  function validateMediaUrl(value) {
    if (typeof value !== "string" || !value) {
      return { ok: false, error: "Missing media URL." };
    }

    if (value.startsWith("data:")) {
      if (!/^data:(?:image|video)\/[a-z0-9.+-]+[;,]/i.test(value)) {
        return { ok: false, error: "Only image or video data URLs are allowed." };
      }
      if (value.length > MAX_DATA_URL_LENGTH) {
        return { ok: false, error: "This embedded media is too large to pass safely." };
      }
      return { ok: true, value };
    }

    if (value.length > MAX_HTTP_URL_LENGTH) {
      return { ok: false, error: "The media URL is too long." };
    }

    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { ok: false, error: `Unsupported URL scheme: ${parsed.protocol}` };
      }
      parsed.hash = "";
      return { ok: true, value: parsed.href };
    } catch (_error) {
      return { ok: false, error: "Invalid media URL." };
    }
  }

  const validateDownloadUrl = validateMediaUrl;

  function shortStableHash(value) {
    let first = 2166136261;
    let second = 2654435761;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second ^= code + index;
      second = Math.imul(second, 2246822519);
    }
    return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
  }

  function ignoreKeyForUrl(value) {
    const result = validateDownloadUrl(value);
    if (!result.ok) {
      return "";
    }
    const prefix = /^data:(?:image|video)\//i.test(result.value) ? "data" : "url";
    return `${prefix}:${result.value.length}:${shortStableHash(result.value)}`;
  }

  function siteKeyForUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "";
    } catch (_error) {
      return "";
    }
  }

  function buildDownloadPath(folder, filename) {
    const folderResult = validateFolderPath(folder);
    if (!folderResult.ok) {
      throw new Error(folderResult.error);
    }
    return `${folderResult.value}/${sanitizeFilename(filename, "image")}`;
  }

  const api = Object.freeze({
    DEFAULT_FOLDER,
    MAX_BATCH_SIZE,
    MAX_BATCH_TOTAL_URL_LENGTH,
    buildDownloadPath,
    filenameForImage,
    filenameForMedia,
    ignoreKeyForUrl,
    sanitizeFilename,
    sanitizePathSegment,
    siteKeyForUrl,
    uniquifyFilename,
    validateDownloadUrl,
    validateMediaUrl,
    validateFolderPath
  });

  root.ImageDownloaderCore = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
