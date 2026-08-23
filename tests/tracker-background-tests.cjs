"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Core = require("../extension/shared/core.js");
const Filters = require("../extension/shared/filters.js");
const Templates = require("../extension/shared/templates.js");
const Tracker = require("../extension/shared/tracker.js");
const DownloadQueue = require("../extension/shared/download-queue.js");

function storageArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) {
        return { ...data };
      }
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => name in data).map((name) => [name, data[name]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    }
  };
}

class NodeFixture {
  constructor(localName, attributes) {
    this.localName = localName;
    this.attributes = attributes;
  }

  getAttribute(name) {
    return this.attributes[name] == null ? null : this.attributes[name];
  }
}

class DOMParserFixture {
  parseFromString(html) {
    const nodes = [];
    for (const match of String(html).matchAll(/<(img|video|a|link)\b([^>]*)>/gi)) {
      const attributes = {};
      for (const attribute of match[2].matchAll(/([\w-]+)=["']([^"']*)["']/g)) {
        attributes[attribute[1].toLowerCase()] = attribute[2];
      }
      nodes.push(new NodeFixture(match[1].toLowerCase(), attributes));
    }
    const titleMatch = String(html).match(/<title>([^<]*)<\/title>/i);
    return {
      documentElement: {},
      title: titleMatch ? titleMatch[1] : "",
      querySelectorAll() {
        return nodes;
      },
      querySelector(selector) {
        if (selector === "a.next" || selector === ".pagination a.next" || selector === ".pager a.next") {
          return nodes.find((node) => node.localName === "a" && String(node.attributes.class || "").split(/\s+/).includes("next")) || null;
        }
        if (selector === "a[rel~='next']" || selector === "link[rel~='next']") {
          const localName = selector.startsWith("link") ? "link" : "a";
          return nodes.find((node) => node.localName === localName && String(node.attributes.rel || "").split(/\s+/).includes("next")) || null;
        }
        return null;
      }
    };
  }
}

class AbortControllerFixture {
  constructor() {
    this.signal = { aborted: false };
  }

  abort() {
    this.signal.aborted = true;
  }
}

function htmlResponse(url, html) {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") {
          return "text/html; charset=utf-8";
        }
        if (String(name).toLowerCase() === "content-length") {
          return String(bytes.byteLength);
        }
        return null;
      }
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function errorResponse(url, status, retryAfter) {
  return {
    ok: false,
    status,
    url,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "retry-after" ? retryAfter || null : null;
      }
    }
  };
}

(async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../extension/background.js"),
    "utf8"
  );
  const local = storageArea();
  const session = storageArea();
  const alarms = new Map();
  const fetchRequests = [];
  const fetchOverrides = new Map();
  const downloadRequests = [];
  const notificationRequests = [];
  const openedTabs = [];
  let pageHtml = "";
  let runtimeMessage = null;
  let alarmListener = null;
  let notificationClickListener = null;
  let permissionRemovedListener = null;
  let permissionGranted = true;
  let nextDownloadId = 100;
  let nextUuid = 1;

  const browser = {
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {}
    },
    alarms: {
      create(name, details) {
        alarms.set(name, { name, ...details, periodInMinutes: details.periodInMinutes });
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async getAll() {
        return Array.from(alarms.values());
      },
      onAlarm: {
        addListener(listener) {
          alarmListener = listener;
        }
      }
    },
    downloads: {
      onChanged: { addListener() {} },
      async download(details) {
        downloadRequests.push(details);
        return nextDownloadId++;
      },
      async search() {
        return [];
      }
    },
    menus: {
      create() {},
      onClicked: { addListener() {} },
      async removeAll() {}
    },
    notifications: {
      async create(id, details) {
        notificationRequests.push({ id, details });
        return id;
      },
      async clear() {
        return true;
      },
      onClicked: {
        addListener(listener) {
          notificationClickListener = listener;
        }
      }
    },
    permissions: {
      async contains(details) {
        return permissionGranted &&
          JSON.stringify(details) === JSON.stringify({ origins: ["https://example.test/*"] });
      },
      onRemoved: {
        addListener(listener) {
          permissionRemovedListener = listener;
        }
      }
    },
    runtime: {
      lastError: null,
      getURL(value) {
        return `moz-extension://tracker-test/${value}`;
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(listener) {
          runtimeMessage = listener;
        }
      }
    },
    storage: { local, session },
    tabs: {
      async create(details) {
        openedTabs.push(details);
        return { id: openedTabs.length, ...details };
      }
    },
    windows: {}
  };

  const trackedUrl = "https://example.test/gallery";
  const sandbox = {
    AbortController: AbortControllerFixture,
    AnyDownloadTracker: Tracker,
    Blob: class BlobFixture {},
    DOMParser: DOMParserFixture,
    Date,
    ImageDownloaderArchive: {},
    ImageDownloaderCore: Core,
    ImageDownloaderDownloadQueue: DownloadQueue,
    ImageDownloaderFilters: Filters,
    ImageDownloaderTemplates: Templates,
    TextDecoder,
    Uint8Array,
    URL,
    browser,
    clearTimeout,
    console,
    crypto: {
      randomUUID() {
        return `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, "0")}`;
      }
    },
    async fetch(url, options) {
      fetchRequests.push({ url, options });
      if (fetchOverrides.has(url)) {
        const override = fetchOverrides.get(url);
        return typeof override === "function" ? override(url, options) : override;
      }
      return htmlResponse(url, pageHtml);
    },
    setTimeout
  };
  vm.runInNewContext(source, sandbox, { filename: "background-tracker.js" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof runtimeMessage, "function");
  assert.equal(typeof alarmListener, "function");
  assert.equal(typeof notificationClickListener, "function");
  assert.equal(typeof permissionRemovedListener, "function");

  pageHtml = "<!doctype html><title>Tracked gallery</title><img src='/media/one.jpg' alt='portrait'>";
  const created = await runtimeMessage({
    type: "UPSERT_TRACKER",
    incognito: false,
    tracker: {
      url: trackedUrl,
      pageTitle: "Tracked gallery",
      folder: "Tracked/example.test",
      intervalMinutes: 15,
      filters: { mediaType: "image", photosOnly: false, format: "jpeg" },
      query: "",
      filenameTemplate: "{index}-{filename}",
      downloadInitial: false
    }
  });
  assert.equal(created.ok, true);
  assert.equal(created.tracker.initialized, true);
  assert.equal(created.tracker.seenCount, 1);
  assert.equal(created.tracker.lastQueued, 0, "The default first check only records a baseline");
  assert.equal(created.tracker.activity.length, 1);
  assert.equal(created.tracker.activity[0].status, "baseline");
  assert.equal(created.tracker.activity[0].pagesChecked, 1);
  assert.equal(downloadRequests.length, 0);
  assert.ok(alarms.has(`${Tracker.ALARM_PREFIX}${created.tracker.id}`));
  assert.equal(fetchRequests[0].options.credentials, "include");
  assert.equal(fetchRequests[0].options.cache, "no-store");
  assert.equal(fetchRequests[0].options.redirect, "error");
  const initialList = await runtimeMessage({ type: "GET_TRACKERS" });
  assert.equal(initialList.ok, true);
  assert.equal(initialList.trackers.length, 1);
  assert.equal(initialList.trackers[0].id, created.tracker.id);
  assert.equal(initialList.maxTrackers, Tracker.MAX_TRACKERS);

  pageHtml = [
    "<!doctype html><title>Tracked gallery</title>",
    "<img src='/media/one.jpg' alt='portrait'>",
    "<img src='/media/two.jpg?token=fresh' alt='portrait'>"
  ].join("");
  const manual = await runtimeMessage({ type: "RUN_TRACKER", id: created.tracker.id });
  assert.equal(manual.ok, true);
  assert.equal(manual.tracker.lastQueued, 1);
  assert.equal(downloadRequests.length, 1);
  assert.equal(downloadRequests[0].url, "https://example.test/media/two.jpg?token=fresh");
  assert.equal(downloadRequests[0].filename, "Tracked/example.test/0001-two.jpg");
  assert.equal(manual.tracker.activity.length, 2);
  assert.equal(manual.tracker.activity[1].status, "success");
  assert.equal(notificationRequests.length, 1);
  assert.match(notificationRequests[0].details.message, /1 new match was added/);

  await notificationClickListener(notificationRequests[0].id);
  assert.equal(openedTabs.length, 1);
  assert.equal(openedTabs[0].url, "moz-extension://tracker-test/tracking/tracking.html");

  pageHtml += "<img src='/media/three.jpg' alt='portrait'>";
  local.data[Tracker.STORAGE_KEY][0].nextRunAt = 0;
  await alarmListener({ name: `${Tracker.ALARM_PREFIX}${created.tracker.id}` });
  assert.equal(downloadRequests.length, 2, "The alarm should queue only the newly discovered media");
  assert.equal(downloadRequests[1].url, "https://example.test/media/three.jpg");

  const pageTwoUrl = "https://example.test/gallery?page=2";
  const pageThreeUrl = "https://example.test/gallery?page=3";
  fetchOverrides.set(trackedUrl, htmlResponse(trackedUrl, pageHtml));
  fetchOverrides.set(pageTwoUrl, htmlResponse(pageTwoUrl, "<title>Page two</title><img src='/media/four.jpg' alt='portrait'>"));
  fetchOverrides.set(pageThreeUrl, htmlResponse(pageThreeUrl, "<title>Page three</title><img src='/media/five.jpg' alt='portrait'>"));
  const paginated = await runtimeMessage({
    type: "UPSERT_TRACKER",
    incognito: false,
    tracker: {
      url: trackedUrl,
      pageTitle: "Tracked gallery",
      folder: "Tracked/example.test",
      intervalMinutes: 15,
      filters: { mediaType: "image", photosOnly: false, format: "jpeg" },
      matching: {
        includeText: "portrait",
        excludeText: "thumbnail",
        includePatterns: ["*.jpg", "*.jpg?*"],
        excludePatterns: ["*/thumbs/*"],
        maxDownloadsPerRun: 1
      },
      pagination: {
        mode: "url-template",
        maxPages: 3,
        urlTemplate: "https://example.test/gallery?page={page}"
      },
      notifications: { newMatches: true, errors: true },
      filenameTemplate: "{index}-{filename}",
      downloadInitial: false
    }
  });
  assert.equal(paginated.ok, true);
  assert.equal(paginated.tracker.lastPagesChecked, 3);
  assert.equal(paginated.tracker.lastFound, 5);
  assert.equal(paginated.tracker.lastQueued, 1, "The per-check cap should leave later matches unseen for the next check");
  assert.equal(downloadRequests[2].url, "https://example.test/media/four.jpg");
  assert.ok(fetchRequests.some((request) => request.url === pageTwoUrl));
  assert.ok(fetchRequests.some((request) => request.url === pageThreeUrl));
  assert.equal(paginated.tracker.activity[paginated.tracker.activity.length - 1].pagesChecked, 3);
  fetchOverrides.clear();

  const paused = await runtimeMessage({
    type: "SET_TRACKER_ENABLED",
    id: created.tracker.id,
    enabled: false
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.tracker.enabled, false);
  assert.ok(!alarms.has(`${Tracker.ALARM_PREFIX}${created.tracker.id}`));
  const fetchCountBeforePausedAlarm = fetchRequests.length;
  await alarmListener({ name: `${Tracker.ALARM_PREFIX}${created.tracker.id}` });
  assert.equal(fetchRequests.length, fetchCountBeforePausedAlarm, "A stale alarm must not run a paused tracker");

  const updatedWhilePaused = await runtimeMessage({
    type: "UPSERT_TRACKER",
    incognito: false,
    tracker: {
      url: trackedUrl,
      pageTitle: "Tracked gallery",
      folder: "Tracked/updated",
      intervalMinutes: 60,
      filters: { mediaType: "image", photosOnly: false, format: "jpeg" },
      query: "",
      filenameTemplate: "{index}-{filename}",
      downloadInitial: false
    }
  });
  assert.equal(updatedWhilePaused.ok, true);
  assert.equal(updatedWhilePaused.tracker.enabled, false, "Editing a paused tracker must not resume it");
  assert.equal(updatedWhilePaused.tracker.folder, "Tracked/updated");
  assert.equal(fetchRequests.length, fetchCountBeforePausedAlarm, "Editing a paused tracker must not run it");

  const resumedAll = await runtimeMessage({ type: "SET_ALL_TRACKERS_ENABLED", enabled: true });
  assert.equal(resumedAll.ok, true);
  assert.equal(resumedAll.trackers[0].enabled, true);
  assert.ok(alarms.has(`${Tracker.ALARM_PREFIX}${created.tracker.id}`));

  fetchOverrides.set(trackedUrl, errorResponse(trackedUrl, 429, "120"));
  const rateLimited = await runtimeMessage({ type: "RUN_TRACKER", id: created.tracker.id });
  assert.equal(rateLimited.ok, true);
  assert.equal(rateLimited.tracker.enabled, true);
  assert.equal(rateLimited.tracker.consecutiveErrors, 1);
  assert.equal(rateLimited.tracker.consecutiveAuthorizationErrors, 0);
  assert.ok(rateLimited.tracker.backoffUntil > Date.now());
  assert.match(rateLimited.tracker.lastError, /rate-limited/);
  assert.equal(rateLimited.tracker.activity[rateLimited.tracker.activity.length - 1].status, "error");
  assert.match(notificationRequests[notificationRequests.length - 1].details.title, /needs attention/);
  fetchOverrides.clear();

  fetchOverrides.set(trackedUrl, errorResponse(trackedUrl, 403));
  const firstAuthorizationFailure = await runtimeMessage({ type: "RUN_TRACKER", id: created.tracker.id });
  const secondAuthorizationFailure = await runtimeMessage({ type: "RUN_TRACKER", id: created.tracker.id });
  const thirdAuthorizationFailure = await runtimeMessage({ type: "RUN_TRACKER", id: created.tracker.id });
  assert.equal(firstAuthorizationFailure.tracker.enabled, true);
  assert.equal(firstAuthorizationFailure.tracker.consecutiveAuthorizationErrors, 1);
  assert.equal(secondAuthorizationFailure.tracker.enabled, true);
  assert.equal(secondAuthorizationFailure.tracker.consecutiveAuthorizationErrors, 2);
  assert.equal(thirdAuthorizationFailure.tracker.enabled, false);
  assert.equal(thirdAuthorizationFailure.tracker.consecutiveAuthorizationErrors, 3);
  assert.match(thirdAuthorizationFailure.tracker.autoPausedReason, /three consecutive authorization failures/);
  assert.ok(!alarms.has(`${Tracker.ALARM_PREFIX}${created.tracker.id}`));
  fetchOverrides.clear();

  const resumedAfterAuthorization = await runtimeMessage({ type: "SET_TRACKER_ENABLED", id: created.tracker.id, enabled: true });
  assert.equal(resumedAfterAuthorization.tracker.enabled, true);
  assert.equal(resumedAfterAuthorization.tracker.consecutiveAuthorizationErrors, 0);

  permissionGranted = false;
  const accessRemoved = await runtimeMessage({ type: "RUN_TRACKER", id: created.tracker.id });
  assert.equal(accessRemoved.ok, true);
  assert.equal(accessRemoved.tracker.enabled, false);
  assert.equal(accessRemoved.tracker.autoPausedReason, "Site access was removed.");
  assert.equal(accessRemoved.tracker.backoffUntil, 0);
  assert.ok(!alarms.has(`${Tracker.ALARM_PREFIX}${created.tracker.id}`));
  permissionGranted = true;

  const resumedAfterPermission = await runtimeMessage({ type: "SET_ALL_TRACKERS_ENABLED", enabled: true });
  assert.equal(resumedAfterPermission.trackers[0].enabled, true);
  assert.equal(resumedAfterPermission.trackers[0].consecutiveErrors, 0);
  assert.equal(resumedAfterPermission.trackers[0].autoPausedReason, "");
  const pausedAll = await runtimeMessage({ type: "SET_ALL_TRACKERS_ENABLED", enabled: false });
  assert.equal(pausedAll.ok, true);
  assert.equal(pausedAll.trackers[0].enabled, false);
  assert.ok(!alarms.has(`${Tracker.ALARM_PREFIX}${created.tracker.id}`));

  const removed = await runtimeMessage({ type: "DELETE_TRACKER", id: created.tracker.id });
  assert.equal(removed.ok, true);
  assert.equal(removed.tracker, null);
  const fetchedTracker = await runtimeMessage({ type: "GET_TRACKER", url: trackedUrl });
  assert.equal(fetchedTracker.tracker, null);

  console.log("Background tracker integration tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
