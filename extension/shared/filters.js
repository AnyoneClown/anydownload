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

  const DEFAULT_FILTERS = Object.freeze({
    mediaType: "any",
    photosOnly: false,
    minWidth: 0,
    minHeight: 0,
    format: "any",
    orientation: "any",
    includeUnknown: true
  });

  function readProperty(object, key) {
    try {
      return object && typeof object === "object" ? object[key] : undefined;
    } catch (_error) {
      return undefined;
    }
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

  function normalizeOrientation(value) {
    let normalized = "";
    try {
      normalized = String(value == null ? "" : value).trim().toLowerCase();
    } catch (_error) {
      return DEFAULT_FILTERS.orientation;
    }
    return VALID_ORIENTATIONS.has(normalized) ? normalized : DEFAULT_FILTERS.orientation;
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
    return {
      mediaType: normalizeMediaType(
        readProperty(filters, "mediaType"),
        DEFAULT_FILTERS.mediaType
      ),
      photosOnly: normalizeBoolean(
        readProperty(filters, "photosOnly"),
        DEFAULT_FILTERS.photosOnly
      ),
      minWidth: normalizeDimension(readProperty(filters, "minWidth")),
      minHeight: normalizeDimension(readProperty(filters, "minHeight")),
      format: normalizeFormat(readProperty(filters, "format"), DEFAULT_FILTERS.format),
      orientation: normalizeOrientation(readProperty(filters, "orientation")),
      includeUnknown: normalizeBoolean(
        readProperty(filters, "includeUnknown"),
        DEFAULT_FILTERS.includeUnknown
      )
    };
  }

  function imageFileType(image) {
    for (const key of ["mimeType", "contentType", "type"]) {
      const directType = normalizeFormat(readProperty(image, key), "");
      if (directType) {
        return directType;
      }
    }

    let url = readProperty(image, "url");
    try {
      url = String(url == null ? "" : url).trim();
    } catch (_error) {
      return "unknown";
    }
    if (!url) {
      return "unknown";
    }

    const dataMime = url.match(/^data:([^;,]+)/i);
    if (dataMime) {
      return normalizeFormat(dataMime[1], "unknown");
    }

    try {
      const parsed = new URL(url);
      for (const key of ["format", "fm"]) {
        const queryType = normalizeFormat(parsed.searchParams.get(key), "");
        if (queryType) {
          return queryType;
        }
      }
      const extension = parsed.pathname.match(/\.([a-z0-9+]+)$/i);
      return extension ? normalizeFormat(extension[1], "unknown") : "unknown";
    } catch (_error) {
      const cleanUrl = url.split(/[?#]/, 1)[0];
      const extension = cleanUrl.match(/\.([a-z0-9+]+)$/i);
      return extension ? normalizeFormat(extension[1], "unknown") : "unknown";
    }
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

  function matchesOrientation(width, height, orientation) {
    if (orientation === "landscape") {
      return width > height;
    }
    if (orientation === "portrait") {
      return height > width;
    }
    if (orientation === "square") {
      return width === height;
    }
    return true;
  }

  function matchesSmartFilters(image, filters) {
    if (!image || typeof image !== "object") {
      return false;
    }

    const normalized = normalizeFilters(filters);
    const dimensions = imageDimensions(image);
    const dimensionsKnown = dimensions.width > 0 && dimensions.height > 0;

    if (normalized.mediaType !== "any" && mediaTypeForItem(image) !== normalized.mediaType) {
      return false;
    }
    if (!dimensionsKnown && !normalized.includeUnknown) {
      return false;
    }
    if (normalized.photosOnly && !isLikelyPhoto(image)) {
      return false;
    }
    if (normalized.format !== "any" && imageFileType(image) !== normalized.format) {
      return false;
    }
    if (dimensions.width && dimensions.width < normalized.minWidth) {
      return false;
    }
    if (dimensions.height && dimensions.height < normalized.minHeight) {
      return false;
    }

    if (!dimensionsKnown) {
      return true;
    }
    return matchesOrientation(dimensions.width, dimensions.height, normalized.orientation);
  }

  function hasActiveSmartFilters(filters) {
    const normalized = normalizeFilters(filters);
    return normalized.mediaType !== DEFAULT_FILTERS.mediaType ||
      normalized.photosOnly !== DEFAULT_FILTERS.photosOnly ||
      normalized.minWidth !== DEFAULT_FILTERS.minWidth ||
      normalized.minHeight !== DEFAULT_FILTERS.minHeight ||
      normalized.format !== DEFAULT_FILTERS.format ||
      normalized.orientation !== DEFAULT_FILTERS.orientation ||
      normalized.includeUnknown !== DEFAULT_FILTERS.includeUnknown;
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
