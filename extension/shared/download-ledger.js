(function attachAnyDownloadLedger(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
    return;
  }
  root.AnyDownloadLedger = api;
})(typeof globalThis === "object" ? globalThis : this, function createAnyDownloadLedger() {
  "use strict";

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = "downloadLedger:v1";
  const MAX_ENTRIES = 5000;
  const MAX_ENTRIES_PER_SITE = 500;
  const MAX_FILENAME_LENGTH = 180;
  const VOLATILE_QUERY_PARAM = /^(?:x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders)|x-goog-(?:algorithm|credential|date|expires|signature|signedheaders)|expires?|expiry|exp|signature|sig|policy|key-pair-id|auth(?:entication)?|access[_-]?token|session[_-]?token|token|utm_[a-z0-9_]+|fbclid|gclid|dclid|_?cb|cache(?:buster)?|timestamp)$/i;

  function safeText(value, maximum) {
    return typeof value === "string"
      ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum || 500)
      : "";
  }

  function safeProperty(value, key) {
    try {
      return value && typeof value === "object" ? value[key] : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  function boundedTime(value, fallback) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) {
      return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
    }
    return Number(fallback) || 0;
  }

  function siteKeyForUrl(value) {
    try {
      const parsed = new URL(safeText(value, 16384));
      return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname
        ? parsed.origin.slice(0, 300)
        : "";
    } catch (_error) {
      return "";
    }
  }

  function normalizeFingerprint(value) {
    const fingerprint = safeText(value, 40).toLowerCase();
    return /^[a-f0-9]{16}$/.test(fingerprint) ? fingerprint : "";
  }

  function shortHash(value) {
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

  function stableMediaValue(item) {
    const identityKey = safeText(safeProperty(item, "identityKey"), 300);
    if (identityKey) {
      return `identity:${identityKey}`;
    }
    const rawUrl = safeText(safeProperty(item, "url"), 500000);
    if (!rawUrl) {
      return "";
    }
    if (/^data:(?:image|video)\//i.test(rawUrl)) {
      return `data:${rawUrl.length}:${shortHash(rawUrl)}`;
    }
    try {
      const parsed = new URL(rawUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
        return "";
      }
      const stableParameters = [];
      for (const [name, value] of parsed.searchParams) {
        if (!VOLATILE_QUERY_PARAM.test(name)) {
          stableParameters.push([name, value]);
        }
      }
      stableParameters.sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
      );
      parsed.search = "";
      for (const [name, value] of stableParameters) {
        parsed.searchParams.append(name, value);
      }
      parsed.hash = "";
      return `url:${parsed.href}`;
    } catch (_error) {
      return "";
    }
  }

  function mediaFingerprint(item) {
    const stable = stableMediaValue(item);
    return stable ? shortHash(stable) : "";
  }

  function normalizeEntry(value, fallbackTime) {
    const siteKey = siteKeyForUrl(safeProperty(value, "siteKey"));
    const fingerprint = normalizeFingerprint(safeProperty(value, "fingerprint"));
    if (!siteKey || !fingerprint) {
      return null;
    }
    const mediaType = safeText(safeProperty(value, "mediaType"), 20).toLowerCase() === "video"
      ? "video"
      : "image";
    return {
      siteKey,
      fingerprint,
      completedAt: boundedTime(safeProperty(value, "completedAt"), fallbackTime),
      filename: safeText(safeProperty(value, "filename"), MAX_FILENAME_LENGTH),
      mediaType
    };
  }

  function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, entries: [] };
  }

  function hydrate(value) {
    if (!value || typeof value !== "object") {
      return emptyState();
    }
    const version = Number(safeProperty(value, "schemaVersion"));
    if (Number.isFinite(version) && version > SCHEMA_VERSION) {
      return emptyState();
    }
    const entries = [];
    const unique = new Set();
    const siteCounts = new Map();
    const rawEntries = Array.isArray(safeProperty(value, "entries"))
      ? safeProperty(value, "entries")
      : [];
    const normalized = rawEntries
      .map((entry) => normalizeEntry(entry, 0))
      .filter(Boolean)
      .sort((left, right) => right.completedAt - left.completedAt);
    for (const entry of normalized) {
      const key = `${entry.siteKey}\n${entry.fingerprint}`;
      const siteCount = siteCounts.get(entry.siteKey) || 0;
      if (unique.has(key) || siteCount >= MAX_ENTRIES_PER_SITE || entries.length >= MAX_ENTRIES) {
        continue;
      }
      unique.add(key);
      siteCounts.set(entry.siteKey, siteCount + 1);
      entries.push(entry);
    }
    return { schemaVersion: SCHEMA_VERSION, entries };
  }

  function recordCompletions(inputState, additions, options) {
    const now = boundedTime(options && options.now, Date.now());
    const current = hydrate(inputState);
    const incoming = [];
    for (const value of Array.isArray(additions) ? additions : []) {
      const entry = normalizeEntry(value, now);
      if (entry) {
        incoming.push(entry);
      }
    }
    return hydrate({
      schemaVersion: SCHEMA_VERSION,
      entries: [...incoming, ...current.entries]
    });
  }

  function findEntry(inputState, siteKeyValue, fingerprintValue) {
    const siteKey = siteKeyForUrl(siteKeyValue);
    const fingerprint = normalizeFingerprint(fingerprintValue);
    if (!siteKey || !fingerprint) {
      return null;
    }
    return hydrate(inputState).entries.find((entry) =>
      entry.siteKey === siteKey && entry.fingerprint === fingerprint
    ) || null;
  }

  return Object.freeze({
    SCHEMA_VERSION,
    STORAGE_KEY,
    MAX_ENTRIES,
    MAX_ENTRIES_PER_SITE,
    emptyState,
    hydrate,
    recordCompletions,
    findEntry,
    mediaFingerprint,
    stableMediaValue,
    siteKeyForUrl,
    normalizeFingerprint
  });
});
