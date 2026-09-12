(function attachAnyDownloadCloudSync(root, factory) {
  "use strict";

  const commonJs = typeof module === "object" && module && module.exports;
  const api = factory(
    commonJs ? require("./core.js") : root.ImageDownloaderCore,
    commonJs ? require("./filters.js") : root.ImageDownloaderFilters,
    commonJs ? require("./templates.js") : root.ImageDownloaderTemplates,
    commonJs ? require("./download-ledger.js") : root.AnyDownloadLedger
  );
  if (commonJs) {
    module.exports = api;
  } else {
    root.AnyDownloadCloudSync = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function createAnyDownloadCloudSync(Core, Filters, Templates, Ledger) {
  "use strict";

  const SETTINGS_KEYS = Object.freeze(["includeBackgrounds", "filenameTemplate", "smartFilters", "mediaLayout"]);
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_KEYS = 10004;
  const IGNORE_PREFIX = "ignoredImage:";
  const encoder = new TextEncoder();

  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value));
  }

  function equal(left, right) {
    if (left === right) {
      return true;
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) {
      return false;
    }
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key])
    );
  }

  function encodedSite(value) {
    try {
      const site = decodeURIComponent(value);
      return site.length <= 300 && Core.siteKeyForUrl(site) === site && encodeURIComponent(site) === value
        ? site : "";
    } catch (_error) {
      return "";
    }
  }

  function ignoreSite(key) {
    const match = /^ignoredImage:([^:]+):(?:url|data):[1-9]\d{0,6}:[a-f0-9]{16}$/.exec(key);
    return match ? encodedSite(match[1]) : "";
  }

  function ledgerKey(entry) {
    return `ledger:${encodeURIComponent(entry.siteKey)}:${entry.fingerprint}`;
  }

  function setting(key, value) {
    if (key === "includeBackgrounds" && typeof value === "boolean") {
      return value;
    }
    if (key === "mediaLayout" && ["grid", "list"].includes(value)) {
      return value;
    }
    if (key === "filenameTemplate") {
      const result = Templates.validate(value);
      return result.ok ? result.value : undefined;
    }
    if (key === "smartFilters" && object(value)) {
      return { ...Filters.normalizeFilters(value) };
    }
    return undefined;
  }

  function checkSize(value) {
    if (Object.keys(value).length > MAX_KEYS || encoder.encode(JSON.stringify(value)).byteLength > MAX_BYTES) {
      throw new Error("Cloud sync data exceeds the 4 MiB or 10,004 record limit.");
    }
    return value;
  }

  function normalizeSnapshot(value) {
    if (!object(value)) {
      throw new Error("Cloud sync data must be an object.");
    }
    checkSize(value);
    const result = {};
    const ignoreSites = new Map();
    const ledgerSites = new Map();
    let ignores = 0;
    let ledgerEntries = 0;
    for (const key of Object.keys(value).sort()) {
      let normalized;
      if (SETTINGS_KEYS.includes(key)) {
        normalized = setting(key, value[key]);
      } else if (key.startsWith(IGNORE_PREFIX)) {
        const site = ignoreSite(key);
        if (site && Number.isSafeInteger(value[key]) && value[key] >= 0) {
          const count = (ignoreSites.get(site) || 0) + 1;
          ignoreSites.set(site, count);
          ignores += 1;
          if (count <= Ledger.MAX_ENTRIES_PER_SITE && ignores <= Ledger.MAX_ENTRIES) {
            normalized = value[key];
          }
        }
      } else if (key.startsWith("ledger:")) {
        const match = /^ledger:([^:]+):[a-f0-9]{16}$/.exec(key);
        const entry = object(value[key]) ? Ledger.hydrate({ entries: [value[key]] }).entries[0] : null;
        if (match && encodedSite(match[1]) && entry && ledgerKey(entry) === key) {
          const count = (ledgerSites.get(entry.siteKey) || 0) + 1;
          ledgerSites.set(entry.siteKey, count);
          ledgerEntries += 1;
          if (count <= Ledger.MAX_ENTRIES_PER_SITE && ledgerEntries <= Ledger.MAX_ENTRIES) {
            normalized = entry;
          }
        }
      }
      if (normalized === undefined || !equal(normalized, value[key])) {
        throw new Error("Cloud sync data contains an invalid or excessive record.");
      }
      result[key] = normalized;
    }
    return result;
  }

  function bounded(records) {
    const result = {};
    for (const key of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(records, key)) {
        result[key] = records[key];
      }
    }
    const siteCounts = new Map();
    let total = 0;
    const ignores = Object.entries(records).filter(([key]) => key.startsWith(IGNORE_PREFIX));
    ignores.sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey));
    for (const [key, timestamp] of ignores) {
      const site = ignoreSite(key);
      const count = siteCounts.get(site) || 0;
      if (site && count < Ledger.MAX_ENTRIES_PER_SITE && total < Ledger.MAX_ENTRIES) {
        result[key] = timestamp;
        siteCounts.set(site, count + 1);
        total += 1;
      }
    }
    const entries = Object.keys(records).filter((key) => key.startsWith("ledger:")).sort()
      .map((key) => records[key]);
    for (const entry of Ledger.hydrate({ entries }).entries) {
      result[ledgerKey(entry)] = entry;
    }
    return normalizeSnapshot(result);
  }

  function snapshot(stored) {
    const records = {};
    for (const key of SETTINGS_KEYS) {
      const normalized = setting(key, stored && stored[key]);
      if (normalized !== undefined) {
        records[key] = normalized;
      }
    }
    for (const [key, timestamp] of Object.entries(stored || {})) {
      if (ignoreSite(key) && Number.isSafeInteger(timestamp) && timestamp >= 0) {
        records[key] = timestamp;
      }
    }
    for (const entry of Ledger.hydrate(stored && stored[Ledger.STORAGE_KEY]).entries) {
      records[ledgerKey(entry)] = entry;
    }
    return bounded(records);
  }

  function toStorage(value) {
    const records = normalizeSnapshot(value);
    const stored = {};
    const entries = [];
    for (const [key, record] of Object.entries(records)) {
      if (key.startsWith("ledger:")) {
        entries.push(record);
      } else {
        stored[key] = record;
      }
    }
    stored[Ledger.STORAGE_KEY] = Ledger.hydrate({ entries });
    return stored;
  }

  function merge(base, local, remote) {
    const previous = normalizeSnapshot(base);
    const current = normalizeSnapshot(local);
    const incoming = normalizeSnapshot(remote);
    const result = { ...incoming };
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (!equal(previous[key], current[key])) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          result[key] = current[key];
        } else {
          delete result[key];
        }
      }
    }
    return bounded(result);
  }

  return Object.freeze({ SETTINGS_KEYS, MAX_BYTES, snapshot, normalizeSnapshot, toStorage, merge, equal });
});
