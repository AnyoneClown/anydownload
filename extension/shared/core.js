(function attachImageDownloaderCore(root) {
  "use strict";

  const DEFAULT_FOLDER = "Website images";
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
    "image/webp": "webp"
  };

  function normalizeText(value) {
    const text = String(value == null ? "" : value);
    return typeof text.normalize === "function" ? text.normalize("NFKC") : text;
  }

  function sanitizePathSegment(value, fallback) {
    let safe = normalizeText(value)
      .replace(BIDI_CONTROLS, "")
      .replace(UNSAFE_FILENAME_CHARACTERS, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[. ]+|[. ]+$/g, "");

    if (RESERVED_WINDOWS_NAME.test(safe)) {
      safe = `_${safe}`;
    }

    safe = safe.slice(0, 100).replace(/[. ]+$/g, "");
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

  function imageExtensionFromMime(mime) {
    return MIME_EXTENSIONS[String(mime || "").toLowerCase()] || "";
  }

  function recognizedExtension(filename) {
    const match = String(filename || "").match(/\.([a-z0-9]{2,5})$/i);
    if (!match) {
      return "";
    }
    const extension = match[1].toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) ? extension : "";
  }

  function extensionFromDataUrl(url) {
    const match = String(url || "").match(/^data:([^;,]+)/i);
    return match ? imageExtensionFromMime(match[1]) : "";
  }

  function queryFilename(urlObject) {
    const keys = ["filename", "file", "name", "download"];
    for (const key of keys) {
      const candidate = urlObject.searchParams.get(key);
      if (candidate && recognizedExtension(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  function queryImageExtension(urlObject) {
    const format = (urlObject.searchParams.get("format") || urlObject.searchParams.get("fm") || "")
      .toLowerCase()
      .replace(/^image\//, "");
    return IMAGE_EXTENSIONS.has(format) ? format : "";
  }

  function sanitizeFilename(value, fallback) {
    const safe = sanitizePathSegment(value, fallback || "image");
    if (safe.length <= 180) {
      return safe;
    }

    const dot = safe.lastIndexOf(".");
    const extension = dot > 0 && safe.length - dot <= 10 ? safe.slice(dot) : "";
    return `${safe.slice(0, 180 - extension.length)}${extension}`;
  }

  function filenameForImage(url, index) {
    const sequence = String(Number(index) + 1).padStart(4, "0");
    const fallbackBase = `image-${sequence}`;
    let rawName = "";
    let inferredExtension = "";

    if (String(url).startsWith("data:")) {
      inferredExtension = extensionFromDataUrl(url);
    } else {
      try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split("/").filter(Boolean);
        rawName = safeDecode(pathParts[pathParts.length - 1] || "");
        rawName = queryFilename(parsed) || rawName;
        inferredExtension = queryImageExtension(parsed);
      } catch (_error) {
        rawName = "";
      }
    }

    rawName = rawName || fallbackBase;
    if (!recognizedExtension(rawName) && inferredExtension) {
      rawName = `${rawName}.${inferredExtension}`;
    } else if (!recognizedExtension(rawName)) {
      // Do not preserve an executable or otherwise misleading extension merely
      // because a page placed that URL in an image-related attribute.
      rawName = rawName.replace(/\./g, "_");
    }

    return sanitizeFilename(rawName, fallbackBase);
  }

  function uniquifyFilename(filename, usedNames) {
    const lowerName = filename.toLocaleLowerCase("en-US");
    if (!usedNames.has(lowerName)) {
      usedNames.add(lowerName);
      return filename;
    }

    const dot = filename.lastIndexOf(".");
    const hasExtension = dot > 0 && filename.length - dot <= 10;
    const stem = hasExtension ? filename.slice(0, dot) : filename;
    const extension = hasExtension ? filename.slice(dot) : "";
    let suffix = 2;
    let candidate = "";

    do {
      candidate = `${stem}-${suffix}${extension}`;
      suffix += 1;
    } while (usedNames.has(candidate.toLocaleLowerCase("en-US")));

    usedNames.add(candidate.toLocaleLowerCase("en-US"));
    return candidate;
  }

  function validateDownloadUrl(value) {
    if (typeof value !== "string" || !value) {
      return { ok: false, error: "Missing image URL." };
    }

    if (value.startsWith("data:")) {
      if (!/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) {
        return { ok: false, error: "Only image data URLs are allowed." };
      }
      if (value.length > MAX_DATA_URL_LENGTH) {
        return { ok: false, error: "This embedded image is too large to pass safely." };
      }
      return { ok: true, value };
    }

    if (value.length > MAX_HTTP_URL_LENGTH) {
      return { ok: false, error: "The image URL is too long." };
    }

    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { ok: false, error: `Unsupported URL scheme: ${parsed.protocol}` };
      }
      parsed.hash = "";
      return { ok: true, value: parsed.href };
    } catch (_error) {
      return { ok: false, error: "Invalid image URL." };
    }
  }

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
    const prefix = /^data:image\//i.test(result.value) ? "data" : "url";
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
    ignoreKeyForUrl,
    sanitizeFilename,
    sanitizePathSegment,
    siteKeyForUrl,
    uniquifyFilename,
    validateDownloadUrl,
    validateFolderPath
  });

  root.ImageDownloaderCore = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
