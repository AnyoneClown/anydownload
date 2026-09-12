(function attachImageDownloaderFilters(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
    return;
  }
  root.ImageDownloaderFilters = api;
})(typeof globalThis === "object" ? globalThis : this, function createImageDownloaderFilters() {
  "use strict";

  const MAX_DIMENSION = 1000000;
  const VALID_FORMATS = new Set([
    "any",
    "jpeg",
    "png",
    "webp",
    "gif",
    "svg",
    "avif",
    "m4v",
    "mkv",
    "mov",
    "mp4",
    "ogv",
    "webm"
  ]);
  const VIDEO_FORMATS = new Set(["m4v", "mkv", "mov", "mp4", "ogv", "webm"]);
  const VALID_MEDIA_TYPES = new Set(["any", "image", "video"]);
  const VALID_ORIENTATIONS = new Set(["any", "landscape", "portrait", "square"]);
  const FORMAT_ALIASES = Object.freeze({
    "application/mp4": "mp4",
    "application/ogg": "ogv",
    "application/webm": "webm",
    "application/x-matroska": "mkv",
    apng: "png",
    "image/apng": "png",
    avif: "avif",
    "image/avif": "avif",
    gif: "gif",
    "image/gif": "gif",
    jfif: "jpeg",
    jpe: "jpeg",
    jpeg: "jpeg",
    jpg: "jpeg",
    "image/jpg": "jpeg",
    "image/jpeg": "jpeg",
    png: "png",
    "image/png": "png",
    m4v: "m4v",
    "video/m4v": "m4v",
    "video/x-m4v": "m4v",
    mkv: "mkv",
    "video/x-matroska": "mkv",
    mov: "mov",
    quicktime: "mov",
    "video/quicktime": "mov",
    "video/x-quicktime": "mov",
    mp4: "mp4",
    "video/mp4": "mp4",
    ogg: "ogv",
    ogv: "ogv",
    "video/ogg": "ogv",
    svg: "svg",
    "svg+xml": "svg",
    "image/svg+xml": "svg",
    webp: "webp",
    "image/webp": "webp",
    webm: "webm",
    "video/webm": "webm"
  });
  const NON_PHOTO_TOKEN = /(?:^|[^a-z0-9])(?:analytics|avatar|avatars|badge|badges|beacon|blank|emoji|emojis|emoticon|emoticons|favicon|favicons|gravatar|icon|icons|logo|logos|pixel|pixels|spacer|sprite|sprites|tracker|tracking|transparent)(?:[^a-z0-9]|$)/i;
  const NON_PHOTO_EXTENSION = /\.(?:ico|cur)(?:$|[?#])/i;
  const fileTypeCache = new WeakMap();
  const normalizedFiltersCache = new WeakMap();

  const DEFAULT_FILTERS = Object.freeze({
    mediaType: "any",
    photosOnly: false,
    format: "any",
    minWidth: 0,
    minHeight: 0,
    orientation: "any"
  });

  function readProperty(object, key) {
    try {
      return object && typeof object === "object" ? object[key] : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  function cacheSafeValue(value) {
    return value === null || !["object", "function"].includes(typeof value);
  }

  function normalizeBoolean(value, fallback) {
    if (value === true || value === false) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value !== 0;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["0", "false", "no", "off", ""].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }

  function normalizeDimension(value) {
    let number = 0;
    try {
      number = typeof value === "string" && !value.trim() ? 0 : Number(value);
    } catch (_error) {
      return 0;
    }
    if (!Number.isFinite(number) || number <= 0) {
      return 0;
    }
    return Math.min(MAX_DIMENSION, Math.round(number));
  }

  function normalizeFormat(value, fallback) {
    let normalized = "";
    try {
      normalized = String(value == null ? "" : value).trim().toLowerCase();
    } catch (_error) {
      return fallback;
    }
    normalized = normalized.split(";", 1)[0].trim();
    normalized = FORMAT_ALIASES[normalized] || normalized;
    return VALID_FORMATS.has(normalized) ? normalized : fallback;
  }

  function normalizeMediaType(value, fallback) {
    let normalized = "";
    try {
      normalized = String(value == null ? "" : value).trim().toLowerCase();
    } catch (_error) {
      return fallback;
    }
    return VALID_MEDIA_TYPES.has(normalized) ? normalized : fallback;
  }

  function normalizeFilters(filters) {
    const rawMediaType = readProperty(filters, "mediaType");
    const rawPhotosOnly = readProperty(filters, "photosOnly");
    const rawFormat = readProperty(filters, "format");
    const rawMinWidth = readProperty(filters, "minWidth");
    const rawMinHeight = readProperty(filters, "minHeight");
    const rawOrientation = readProperty(filters, "orientation");
    const cacheable = Boolean(filters) && typeof filters === "object" &&
      [rawMediaType, rawPhotosOnly, rawFormat, rawMinWidth, rawMinHeight, rawOrientation].every(cacheSafeValue);
    const cached = cacheable ? normalizedFiltersCache.get(filters) : null;
    if (
      cached &&
      cached.rawMediaType === rawMediaType &&
      cached.rawPhotosOnly === rawPhotosOnly &&
      cached.rawFormat === rawFormat &&
      cached.rawMinWidth === rawMinWidth &&
      cached.rawMinHeight === rawMinHeight &&
      cached.rawOrientation === rawOrientation
    ) {
      return cached.normalized;
    }

    const orientation = typeof rawOrientation === "string" ? rawOrientation.trim().toLowerCase() : "";
    const normalized = {
      mediaType: normalizeMediaType(rawMediaType, DEFAULT_FILTERS.mediaType),
      photosOnly: normalizeBoolean(rawPhotosOnly, DEFAULT_FILTERS.photosOnly),
      format: normalizeFormat(rawFormat, DEFAULT_FILTERS.format),
      minWidth: normalizeDimension(rawMinWidth),
      minHeight: normalizeDimension(rawMinHeight),
      orientation: VALID_ORIENTATIONS.has(orientation) ? orientation : DEFAULT_FILTERS.orientation
    };
    if (cacheable) {
      normalizedFiltersCache.set(filters, {
        rawMediaType,
        rawPhotosOnly,
        rawFormat,
        rawMinWidth,
        rawMinHeight,
        rawOrientation,
        normalized
      });
    }
    normalizedFiltersCache.set(normalized, {
      rawMediaType: normalized.mediaType,
      rawPhotosOnly: normalized.photosOnly,
      rawFormat: normalized.format,
      rawMinWidth: normalized.minWidth,
      rawMinHeight: normalized.minHeight,
      rawOrientation: normalized.orientation,
      normalized
    });
    return normalized;
  }

  function imageFileType(image) {
    const rawMimeType = readProperty(image, "mimeType");
    const rawContentType = readProperty(image, "contentType");
    const rawType = readProperty(image, "type");
    const rawUrl = readProperty(image, "url");
    const cacheable = Boolean(image) && typeof image === "object" &&
      [rawMimeType, rawContentType, rawType, rawUrl].every(cacheSafeValue);
    const cached = cacheable ? fileTypeCache.get(image) : null;
    if (
      cached &&
      cached.rawMimeType === rawMimeType &&
      cached.rawContentType === rawContentType &&
      cached.rawType === rawType &&
      cached.rawUrl === rawUrl
    ) {
      return cached.result;
    }

    let result = "";
    for (const value of [rawMimeType, rawContentType, rawType]) {
      result = normalizeFormat(value, "");
      if (result) {
        break;
      }
    }

    let url = rawUrl;
    if (!result) {
      try {
        url = String(url == null ? "" : url).trim();
      } catch (_error) {
        url = "";
      }
      if (!url) {
        result = "unknown";
      }
    }

    if (!result) {
      const dataMime = url.match(/^data:([^;,]+)/i);
      if (dataMime) {
        result = normalizeFormat(dataMime[1], "unknown");
      }
    }

    if (!result) {
      try {
        const parsed = new URL(url);
        for (const key of ["format", "fm"]) {
          const queryType = normalizeFormat(parsed.searchParams.get(key), "");
          if (queryType) {
            result = queryType;
            break;
          }
        }
        if (!result) {
          const extension = parsed.pathname.match(/\.([a-z0-9+]+)$/i);
          result = extension ? normalizeFormat(extension[1], "unknown") : "unknown";
        }
      } catch (_error) {
        const cleanUrl = url.split(/[?#]/, 1)[0];
        const extension = cleanUrl.match(/\.([a-z0-9+]+)$/i);
        result = extension ? normalizeFormat(extension[1], "unknown") : "unknown";
      }
    }

    if (cacheable) {
      fileTypeCache.set(image, {
        rawMimeType,
        rawContentType,
        rawType,
        rawUrl,
        result
      });
    }
    return result;
  }

  function imageDimensions(image) {
    return {
      width: normalizeDimension(readProperty(image, "width")),
      height: normalizeDimension(readProperty(image, "height"))
    };
  }

  function mediaTypeForItem(item) {
    const explicit = normalizeMediaType(readProperty(item, "mediaType"), "");
    if (explicit === "image" || explicit === "video") {
      return explicit;
    }

    for (const key of ["mimeType", "contentType", "type"]) {
      let mime = "";
      try {
        mime = String(readProperty(item, key) || "").trim().toLowerCase();
      } catch (_error) {
        mime = "";
      }
      if (mime.startsWith("video/")) {
        return "video";
      }
      if (mime.startsWith("image/")) {
        return "image";
      }
    }

    return VIDEO_FORMATS.has(imageFileType(item)) ? "video" : "image";
  }

  function searchableImageText(image) {
    const values = ["url", "alt", "filename", "name", "title"].map((key) => {
      try {
        return String(readProperty(image, key) || "").slice(0, 2048);
      } catch (_error) {
        return "";
      }
    });
    try {
      return decodeURIComponent(values.join(" ").slice(0, 8192));
    } catch (_error) {
      return values.join(" ").slice(0, 8192);
    }
  }

  function isLikelyPhoto(image) {
    if (!image || typeof image !== "object") {
      return false;
    }

    if (mediaTypeForItem(image) === "video") {
      return false;
    }

    const type = imageFileType(image);
    if (type === "svg") {
      return false;
    }

    const searchableText = searchableImageText(image);
    if (NON_PHOTO_TOKEN.test(searchableText) || NON_PHOTO_EXTENSION.test(searchableText)) {
      return false;
    }

    const dimensions = imageDimensions(image);
    if (dimensions.width && dimensions.height) {
      const area = dimensions.width * dimensions.height;
      if (
        dimensions.width <= 4 ||
        dimensions.height <= 4 ||
        Math.min(dimensions.width, dimensions.height) < 80 ||
        area < 40000
      ) {
        return false;
      }
    }

    return true;
  }

  function matchesSmartFilters(image, filters) {
    if (!image || typeof image !== "object") {
      return false;
    }

    const normalized = normalizeFilters(filters);

    if (normalized.mediaType !== "any" && mediaTypeForItem(image) !== normalized.mediaType) {
      return false;
    }
    if (normalized.photosOnly && !isLikelyPhoto(image)) {
      return false;
    }
    if (normalized.format !== "any" && imageFileType(image) !== normalized.format) {
      return false;
    }
    const { width, height } = imageDimensions(image);
    if (width < normalized.minWidth || height < normalized.minHeight) {
      return false;
    }
    if (normalized.orientation !== "any") {
      if (!width || !height) {
        return false;
      }
      const orientation = width === height ? "square" : width > height ? "landscape" : "portrait";
      if (orientation !== normalized.orientation) {
        return false;
      }
    }
    return true;
  }

  function hasActiveSmartFilters(filters) {
    const normalized = normalizeFilters(filters);
    return normalized.mediaType !== DEFAULT_FILTERS.mediaType ||
      normalized.photosOnly !== DEFAULT_FILTERS.photosOnly ||
      normalized.format !== DEFAULT_FILTERS.format ||
      normalized.minWidth > 0 || normalized.minHeight > 0 ||
      normalized.orientation !== DEFAULT_FILTERS.orientation;
  }

  return Object.freeze({
    DEFAULT_FILTERS,
    normalizeFilters,
    imageFileType,
    isLikelyPhoto,
    matchesSmartFilters,
    hasActiveSmartFilters
  });
});
