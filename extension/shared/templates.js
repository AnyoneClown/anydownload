(function attachImageDownloaderTemplates(root, factory) {
  "use strict";

  const core = typeof module === "object" && module && module.exports
    ? require("./core.js")
    : root.ImageDownloaderCore;
  const api = factory(core);

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
    return;
  }
  root.ImageDownloaderTemplates = api;
})(typeof globalThis === "object" ? globalThis : this, function createImageDownloaderTemplates(Core) {
  "use strict";

  if (!Core || typeof Core.sanitizeFilename !== "function") {
    throw new Error("ImageDownloaderTemplates requires ImageDownloaderCore.");
  }

  const DEFAULT_TEMPLATE = "{filename}";
  const MAX_TEMPLATE_LENGTH = 240;
  // Core.sanitizePathSegment, which backs Core.sanitizeFilename, caps a single
  // Downloads path segment at 100 UTF-16 code units.
  const MAX_FILENAME_LENGTH = 100;
  const TOKENS = Object.freeze([
    "filename",
    "name",
    "ext",
    "index",
    "hostname",
    "page-title",
    "width",
    "height",
    "date"
  ]);
  const TOKEN_SET = new Set(TOKENS);
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
  const MIME_EXTENSIONS = Object.freeze({
    "image/apng": "apng",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/jxl": "jxl",
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
  });
  const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

  function normalize(value) {
    if (typeof value !== "string") {
      return "";
    }
    const normalized = typeof value.normalize === "function" ? value.normalize("NFKC") : value;
    return normalized.trim();
  }

  function validationError(error, value) {
    return Object.freeze({ ok: false, value: value || "", tokens: Object.freeze([]), error });
  }

  function validate(value) {
    if (typeof value !== "string") {
      return validationError("Filename templates must be text.", "");
    }

    const template = normalize(value);
    if (!template) {
      return validationError("Enter a filename template.", template);
    }
    if (template.length > MAX_TEMPLATE_LENGTH) {
      return validationError(
        `Filename templates must be ${MAX_TEMPLATE_LENGTH} characters or fewer.`,
        template
      );
    }
    if (CONTROL_OR_BIDI.test(template)) {
      return validationError("Filename templates cannot contain control or bidirectional characters.", template);
    }
    if (/[\\/]/.test(template)) {
      return validationError("Filename templates cannot contain folder separators.", template);
    }

    const foundTokens = [];
    const seenTokens = new Set();
    let cursor = 0;
    while (cursor < template.length) {
      const character = template[cursor];
      if (character === "}") {
        return validationError("Filename template contains an unmatched } character.", template);
      }
      if (character !== "{") {
        cursor += 1;
        continue;
      }

      const close = template.indexOf("}", cursor + 1);
      if (close < 0 || template.slice(cursor + 1, close).includes("{")) {
        return validationError("Filename template contains an unmatched { character.", template);
      }
      const token = template.slice(cursor + 1, close);
      if (!TOKEN_SET.has(token)) {
        const label = token ? `{${token}}` : "{}";
        return validationError(`Unknown filename token: ${label}.`, template);
      }
      if (!seenTokens.has(token)) {
        seenTokens.add(token);
        foundTokens.push(token);
      }
      cursor = close + 1;
    }

    if (!foundTokens.length && !Core.sanitizePathSegment(template, "")) {
      return validationError("Filename template must produce a visible name.", template);
    }

    return Object.freeze({
      ok: true,
      value: template,
      tokens: Object.freeze(foundTokens),
      changed: template !== value
    });
  }

  function safeProperty(object, key) {
    if (!object || (typeof object !== "object" && typeof object !== "function")) {
      return undefined;
    }
    try {
      return object[key];
    } catch (_error) {
      return undefined;
    }
  }

  function safeText(value, maxLength) {
    let text = "";
    try {
      if (typeof value === "string") {
        text = value;
      } else if (["number", "bigint", "boolean"].includes(typeof value)) {
        text = String(value);
      }
    } catch (_error) {
      text = "";
    }
    return text.slice(0, maxLength || 500);
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

  function positiveInteger(value, fallback) {
    let number;
    try {
      number = Number(value);
    } catch (_error) {
      number = NaN;
    }
    if (!Number.isFinite(number) || number <= 0) {
      return fallback;
    }
    return Math.min(1000000000, Math.max(1, Math.round(number)));
  }

  function normalizeMediaType(value) {
    return safeText(value, 20).trim().toLowerCase() === "video" ? "video" : "image";
  }

  function normalizeMediaExtension(value, mediaType) {
    const normalized = safeText(value, 100).split(";", 1)[0].trim().toLowerCase();
    let extension = MIME_EXTENSIONS[normalized] || normalized
      .replace(/^(?:image|video)\//, "")
      .replace(/^\./, "");
    if (extension === "svg+xml") {
      extension = "svg";
    }
    if (["jfif", "jpe"].includes(extension)) {
      extension = "jpg";
    }
    const extensions = mediaType === "image"
      ? IMAGE_EXTENSIONS
      : mediaType === "video"
        ? VIDEO_EXTENSIONS
        : MEDIA_EXTENSIONS;
    return extensions.has(extension) ? extension : "";
  }

  function extensionFromFilename(value, mediaType) {
    const match = safeText(value, 500).match(/\.([a-z0-9]{2,5})$/i);
    return match ? normalizeMediaExtension(match[1], mediaType) : "";
  }

  function extensionFromMime(value, mediaType) {
    const mime = safeText(value, 100).split(";", 1)[0].trim().toLowerCase();
    const extension = MIME_EXTENSIONS[mime] || "";
    return extension ? normalizeMediaExtension(extension, mediaType) : "";
  }

  function equivalentExtension(first, second) {
    const normalizedFirst = ["jpeg", "jpg"].includes(first) ? "jpg" : first;
    const normalizedSecond = ["jpeg", "jpg"].includes(second) ? "jpg" : second;
    const equivalentFirst = ["ogg", "ogv"].includes(normalizedFirst) ? "ogv" : normalizedFirst;
    const equivalentSecond = ["ogg", "ogv"].includes(normalizedSecond) ? "ogv" : normalizedSecond;
    return Boolean(equivalentFirst && equivalentFirst === equivalentSecond);
  }

  function ensureExtension(value, extension, fallback) {
    let safe = Core.sanitizeFilename(value, fallback);
    if (!extension) {
      return safe;
    }

    const existing = extensionFromFilename(safe);
    if (existing && equivalentExtension(existing, extension)) {
      return safe;
    }
    if (existing) {
      safe = safe.slice(0, -(existing.length + 1));
    }
    const extensionText = `.${extension}`;
    const maximumStemLength = Math.max(1, MAX_FILENAME_LENGTH - extensionText.length);
    const stem = truncateWithoutSplittingSurrogate(safe || fallback, maximumStemLength)
      .replace(/[. ]+$/g, "") || fallback;
    return Core.sanitizeFilename(`${stem}.${extension}`, `${fallback}.${extension}`);
  }

  function formatDate(value) {
    if (value == null || value === "" || typeof value === "boolean") {
      return "unknown-date";
    }
    if (typeof value === "string") {
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) {
        const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        const date = new Date(timestamp);
        if (
          date.getUTCFullYear() === Number(match[1]) &&
          date.getUTCMonth() + 1 === Number(match[2]) &&
          date.getUTCDate() === Number(match[3])
        ) {
          return value;
        }
      }
    }

    let timestamp = NaN;
    try {
      timestamp = value instanceof Date ? Date.prototype.getTime.call(value) : Number(value);
    } catch (_error) {
      timestamp = NaN;
    }
    if (!Number.isFinite(timestamp)) {
      return "unknown-date";
    }

    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      return "unknown-date";
    }
    const numericYear = date.getFullYear();
    if (!Number.isInteger(numericYear) || numericYear < 0 || numericYear > 9999) {
      return "unknown-date";
    }
    const year = String(numericYear).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function hostnameForMetadata(metadata) {
    const explicit = safeText(safeProperty(metadata, "hostname"), 300).trim();
    if (explicit) {
      return explicit;
    }

    const candidates = [safeProperty(metadata, "pageUrl"), safeProperty(metadata, "url")];
    for (const candidate of candidates) {
      try {
        const parsed = new URL(safeText(candidate, 16384));
        if (["http:", "https:"].includes(parsed.protocol) && parsed.hostname) {
          return parsed.hostname;
        }
      } catch (_error) {
        // Try the next candidate.
      }
    }
    return "unknown-host";
  }

  function metadataValues(metadata) {
    const index = positiveInteger(safeProperty(metadata, "index"), 1);
    const sequence = String(index).padStart(4, "0");
    const mediaType = normalizeMediaType(safeProperty(metadata, "mediaType"));
    const fallback = `${mediaType}-${sequence}`;
    const url = safeText(safeProperty(metadata, "url"), 16384);
    const providedFilename = safeText(safeProperty(metadata, "filename"), 500).trim();
    const inferredFilename = typeof Core.filenameForMedia === "function"
      ? Core.filenameForMedia(url, index - 1, mediaType)
      : Core.filenameForImage(url, index - 1);
    const baseFilename = Core.sanitizeFilename(providedFilename || inferredFilename, fallback);
    const extension = normalizeMediaExtension(safeProperty(metadata, "ext"), mediaType) ||
      extensionFromMime(safeProperty(metadata, "mimeType"), mediaType) ||
      extensionFromFilename(baseFilename, mediaType) ||
      extensionFromFilename(inferredFilename, mediaType);
    const filename = ensureExtension(baseFilename, extension, fallback);
    const filenameExtension = extensionFromFilename(filename, mediaType);
    const name = filenameExtension
      ? filename.slice(0, -(filenameExtension.length + 1))
      : filename;
    const pageTitle = safeText(safeProperty(metadata, "pageTitle"), 500).trim() || "untitled";
    const width = positiveInteger(safeProperty(metadata, "width"), 0);
    const height = positiveInteger(safeProperty(metadata, "height"), 0);

    return Object.freeze({
      filename,
      name: name || fallback,
      ext: filenameExtension || extension,
      index: sequence,
      hostname: hostnameForMetadata(metadata),
      "page-title": pageTitle,
      width: width ? String(width) : "unknown",
      height: height ? String(height) : "unknown",
      date: formatDate(safeProperty(metadata, "date")),
      fallback,
      extension: filenameExtension || extension
    });
  }

  function usedNameKey(value) {
    const normalized = typeof value.normalize === "function" ? value.normalize("NFKC") : value;
    return normalized.toLocaleLowerCase("en-US");
  }

  function hasUsedName(usedNames, key) {
    if (usedNames.has(key)) {
      return true;
    }
    try {
      for (const value of usedNames) {
        if (typeof value === "string" && usedNameKey(value) === key) {
          return true;
        }
      }
    } catch (_error) {
      // Non-iterable set-like objects can still use their has/add methods.
    }
    return false;
  }

  function uniquify(value, extension, fallback, usedNames) {
    if (!usedNames) {
      return value;
    }
    if (typeof usedNames.has !== "function" || typeof usedNames.add !== "function") {
      throw new TypeError("options.usedNames must be a Set or set-like object.");
    }

    let candidate = value;
    let suffix = 1;
    while (hasUsedName(usedNames, usedNameKey(candidate))) {
      suffix += 1;
      const existingExtension = extensionFromFilename(value);
      const suffixText = `-${suffix}`;
      const extensionText = existingExtension ? `.${existingExtension}` : "";
      const stem = existingExtension
        ? value.slice(0, -(existingExtension.length + 1))
        : value;
      const maximumStemLength = Math.max(1, MAX_FILENAME_LENGTH - suffixText.length - extensionText.length);
      candidate = Core.sanitizeFilename(
        `${truncateWithoutSplittingSurrogate(stem, maximumStemLength)}${suffixText}${extensionText}`,
        `${fallback}${suffixText}${extensionText}`
      );
      candidate = ensureExtension(candidate, extension, `${fallback}${suffixText}`);
      if (suffix > 1000000) {
        throw new Error("Could not create a unique filename.");
      }
    }
    usedNames.add(usedNameKey(candidate));
    return candidate;
  }

  function render(template, metadata, options) {
    const result = validate(template);
    if (!result.ok) {
      throw new Error(result.error);
    }

    const values = metadataValues(metadata);
    const output = result.value.replace(/\{([^{}]+)\}/g, (_match, token) => values[token]);
    const safe = ensureExtension(output, values.extension, values.fallback);
    const usedNames = safeProperty(options, "usedNames");
    return uniquify(safe, values.extension, values.fallback, usedNames);
  }

  function preview(template, metadata, options) {
    const result = validate(template);
    if (!result.ok) {
      return Object.freeze({ ok: false, value: "", template: result.value, error: result.error });
    }

    try {
      let previewOptions;
      const usedNames = safeProperty(options, "usedNames");
      if (usedNames && typeof usedNames[Symbol.iterator] === "function") {
        previewOptions = { usedNames: new Set(usedNames) };
      }
      return Object.freeze({
        ok: true,
        value: render(result.value, metadata, previewOptions),
        template: result.value,
        error: ""
      });
    } catch (error) {
      return Object.freeze({
        ok: false,
        value: "",
        template: result.value,
        error: error && error.message ? error.message : "Could not preview this filename template."
      });
    }
  }

  return Object.freeze({
    DEFAULT_TEMPLATE,
    MAX_FILENAME_LENGTH,
    MAX_TEMPLATE_LENGTH,
    TOKENS,
    normalize,
    validate,
    render,
    preview
  });
});
