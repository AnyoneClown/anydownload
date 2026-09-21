"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { randomFillSync, randomUUID } = require("crypto");
const Templates = require("../extension/shared/templates.js");
const DownloadQueue = require("../extension/shared/download-queue.js");

const QUEUE_STORAGE_KEY = "downloadQueueState:v1";
const SCRIPT_PATHS = [
  "../extension/shared/core.js",
  "../extension/shared/image-fetch.js",
  "../extension/shared/telegram.js",
  "../extension/shared/youtube.js",
  "../extension/shared/templates.js",
  "../extension/shared/download-ledger.js",
  "../extension/shared/gallery.js",
  "../extension/shared/download-queue.js",
  "../extension/background.js"
];

function copy(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function storageArea(initial = {}, options = {}) {
  const data = copy(initial);
  const setFailures = Array.isArray(options.setFailures) ? options.setFailures : [];
  let setCallCount = 0;
  return {
    async get(keys) {
      if (keys == null) {
        return copy(data);
      }
      if (typeof keys === "object" && !Array.isArray(keys)) {
        const result = copy(keys);
        for (const key of Object.keys(keys)) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            result[key] = copy(data[key]);
          }
        }
        return result;
      }
      const names = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of names) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          result[key] = copy(data[key]);
        }
      }
      return result;
    },
    async set(values) {
      setCallCount += 1;
      const failureIndex = setFailures.findIndex((failure) =>
        typeof failure.predicate !== "function" || failure.predicate(copy(values))
      );
      if (failureIndex >= 0) {
        const [failure] = setFailures.splice(failureIndex, 1);
        throw new Error(failure.message || "Synthetic storage failure");
      }
      for (const [key, value] of Object.entries(values || {})) {
        data[key] = copy(value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    },
    dump() {
      return copy(data);
    },
    get setCallCount() {
      return setCallCount;
    }
  };
}

function activeAndPaused(snapshot) {
  return snapshot.summary.active + snapshot.summary.paused;
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function createHarness(options = {}) {
  const localSetFailures = [];
  const local = storageArea(options.local, { setFailures: localSetFailures });
  const session = storageArea(options.session);
  const messageListeners = [];
  const downloadChangeListeners = [];
  const startupListeners = [];
  const installedListeners = [];
  const menuListeners = [];
  const downloadCalls = [];
  const pauseCalls = [];
  const resumeCalls = [];
  const cancelCalls = [];
  const searchFailures = new Set(options.searchFailures || []);
  const rejectingDownloadApis = new Set(options.rejectingDownloadApis || []);
  const rejectFirstDownloads = Math.max(0, Number(options.rejectFirstDownloads) || 0);
  const createdObjectUrls = [];
  const revokedObjectUrls = [];
  const downloads = new Map();
  for (const item of options.downloads || []) {
    downloads.set(item.id, copy(item));
  }
  let nextDownloadId = Math.max(0, ...downloads.keys()) + 1;

  function downloadSnapshot(item) {
    return item ? copy(item) : null;
  }

  const browser = {
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {}
    },
    downloads: {
      onChanged: {
        addListener(listener) {
          downloadChangeListeners.push(listener);
        }
      },
      async download(details) {
        const id = nextDownloadId++;
        downloadCalls.push({ id, ...copy(details) });
        if (downloadCalls.length <= rejectFirstDownloads) {
          throw new Error(`Synthetic start failure ${downloadCalls.length}`);
        }
        downloads.set(id, {
          id,
          url: details.url,
          filename: `/Users/tester/Downloads/${details.filename}`,
          state: "in_progress",
          paused: false,
          bytesReceived: 0,
          totalBytes: 0,
          error: ""
        });
        return id;
      },
      async search(query) {
        if (query && Number.isInteger(query.id)) {
          if (searchFailures.has(query.id)) {
            throw new Error("Transient downloads.search failure");
          }
          const item = downloads.get(query.id);
          return item ? [downloadSnapshot(item)] : [];
        }
        return Array.from(downloads.values(), downloadSnapshot);
      },
      async pause(id) {
        pauseCalls.push(id);
        if (rejectingDownloadApis.has("pause")) {
          throw new Error("Synthetic pause failure");
        }
        const item = downloads.get(id);
        if (!item) {
          throw new Error("Unknown download");
        }
        item.paused = true;
      },
      async resume(id) {
        resumeCalls.push(id);
        if (rejectingDownloadApis.has("resume")) {
          throw new Error("Synthetic resume failure");
        }
        const item = downloads.get(id);
        if (!item) {
          throw new Error("Unknown download");
        }
        item.paused = false;
        item.state = "in_progress";
      },
      async cancel(id) {
        cancelCalls.push(id);
        if (rejectingDownloadApis.has("cancel")) {
          throw new Error("Synthetic cancel failure");
        }
        const item = downloads.get(id);
        if (!item) {
          throw new Error("Unknown download");
        }
        item.state = "interrupted";
        item.error = "USER_CANCELED";
      }
    },
    menus: {
      create(_details, callback) {
        if (callback) {
          callback();
        }
      },
      async removeAll() {},
      onClicked: {
        addListener(listener) {
          menuListeners.push(listener);
        }
      }
    },
    runtime: {
      lastError: null,
      getURL(value) {
        return `moz-extension://anydownload/${value}`;
      },
      onInstalled: {
        addListener(listener) {
          installedListeners.push(listener);
        }
      },
      onStartup: {
        addListener(listener) {
          startupListeners.push(listener);
        }
      },
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        }
      }
    },
    storage: { local, session },
    tabs: {
      async create() {
        return { id: 700 };
      },
      async get(id) {
        return { id, windowId: 70, incognito: false };
      },
      async update() {}
    },
    windows: {
      async create() {
        return { id: 70, tabs: [{ id: 700 }] };
      },
      async get(id) {
        return { id, incognito: false };
      },
      async update() {}
    },
    scripting: {
      async executeScript() {
        return [];
      }
    }
  };

  for (const name of options.unavailableDownloadApis || []) {
    delete browser.downloads[name];
  }

  class TestURL extends URL {}
  TestURL.createObjectURL = () => {
    const objectUrl = `blob:anydownload-${randomUUID()}`;
    createdObjectUrls.push(objectUrl);
    return objectUrl;
  };
  TestURL.revokeObjectURL = (objectUrl) => {
    revokedObjectUrls.push(objectUrl);
  };

  class AbortControllerFixture {
    constructor() {
      this.signal = { aborted: false };
    }

    abort() {
      this.signal.aborted = true;
    }
  }

  class BlobFixture {
    constructor(parts, blobOptions = {}) {
      this.parts = parts;
      this.type = blobOptions.type || "";
    }
  }

  const context = {
    AbortController: AbortControllerFixture,
    Blob: options.nativeBlob ? Blob : BlobFixture,
    TextDecoder,
    TextEncoder,
    URL: TestURL,
    Uint8Array,
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    browser,
    clearTimeout,
    console,
    crypto: {
      randomUUID,
      getRandomValues(array) {
        return randomFillSync(array);
      }
    },
    fetch: typeof options.fetch === "function"
      ? options.fetch
      : async () => {
          throw new Error("Unexpected fetch");
        },
    setTimeout
  };
  vm.createContext(context);
  for (const relativePath of SCRIPT_PATHS) {
    vm.runInContext(
      fs.readFileSync(path.resolve(__dirname, relativePath), "utf8"),
      context,
      { filename: path.basename(relativePath) }
    );
  }

  async function send(message) {
    assert.equal(messageListeners.length, 1, "Background must install one message listener");
    return await messageListeners[0](copy(message), {});
  }

  async function emitDownloadChange(id, delta) {
    const item = downloads.get(id);
    assert.ok(item, `Download ${id} must exist before an event is emitted`);
    for (const [key, value] of Object.entries(delta)) {
      item[key] = value;
    }
    const change = { id };
    for (const [key, value] of Object.entries(delta)) {
      change[key] = { current: value };
    }
    await Promise.all(downloadChangeListeners.map((listener) =>
      listener(copy(change))
    ));
  }

  return {
    browser,
    cancelCalls,
    createdObjectUrls,
    downloadCalls,
    downloads,
    emitDownloadChange,
    failNextLocalSet(predicate, message) {
      localSetFailures.push({ predicate, message });
    },
    local,
    pauseCalls,
    resumeCalls,
    rejectingDownloadApis,
    revokedObjectUrls,
    searchFailures,
    send,
    session,
    triggerStartup() {
      startupListeners.forEach((listener) => listener());
    }
  };
}

async function testEmptyQueueReadsDoNotWriteStorage() {
  const harness = createHarness();
  const normal = await harness.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false
  });
  const privateDashboard = await harness.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: true
  });
  const lightweight = await harness.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false,
    summaryOnly: true
  });
  assert.equal(normal.snapshot.summary.total, 0);
  assert.equal(privateDashboard.snapshot.summary.total, 0);
  assert.deepEqual(Object.keys(lightweight.snapshot), ["summary"]);
  assert.equal(lightweight.snapshot.summary.total, 0);
  assert.equal(
    harness.local.setCallCount,
    0,
    "Reading an unchanged empty queue must not create a durable storage write"
  );
  assert.equal(
    harness.session.setCallCount,
    0,
    "Reading an unchanged private queue must not create a session storage write"
  );
}

async function testQueueConcurrencyProgressAndStatistics() {
  const harness = createHarness();
  const rendered = Templates.render(
    "{page-title}_{index}_{width}x{height}_{name}.{ext}",
    {
      filename: "cat.JPG",
      pageTitle: "Summer Gallery",
      width: 1920,
      height: 1080,
      index: 1
    }
  );
  assert.equal(rendered, "Summer Gallery_0001_1920x1080_cat.jpg");
  const filenames = [rendered, "gallery-0002.jpg", "gallery-0003.webp", "gallery-0004.png"];
  const response = await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/example.test",
    pageTitle: "Summer Gallery",
    pageUrl: "https://example.test/gallery",
    items: filenames.map((filename, index) => ({
      url: `https://cdn.example.test/full/${index + 1}.${index === 2 ? "webp" : "jpg"}`,
      filename
    }))
  });

  assert.equal(response.ok, true);
  assert.equal(response.queued, 4);
  assert.equal(harness.downloadCalls.length, 3, "Only three downloads may start initially");
  assert.deepEqual(
    harness.downloadCalls.map((call) => call.filename),
    filenames.slice(0, 3).map((filename) => `AnyDownload/example.test/${filename}`),
    "Names already rendered from a filename template must reach Firefox unchanged"
  );
  assert.match(
    JSON.stringify(harness.local.dump()),
    /Summer Gallery_0001_1920x1080_cat\.jpg/,
    "The requested template filename must be persisted while the download is active"
  );

  let dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.snapshot.summary.active, 3);
  assert.equal(dashboard.snapshot.summary.queued, 1);
  assert.equal(dashboard.snapshot.stats.lifetime.enqueued, 4);

  const firstTask = dashboard.snapshot.jobs[0].tasks.find((task) => task.downloadId === 1);
  const paused = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "task",
    id: firstTask.id,
    incognito: false
  });
  assert.deepEqual(harness.pauseCalls, [1]);
  assert.equal(paused.snapshot.summary.paused, 1);
  assert.equal(paused.snapshot.summary.queued, 1);
  assert.equal(activeAndPaused(paused.snapshot), 3, "Paused downloads must keep their scheduler slot");
  assert.equal(harness.downloadCalls.length, 3);

  const resumed = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "resume",
    targetType: "task",
    id: firstTask.id,
    incognito: false
  });
  assert.deepEqual(harness.resumeCalls, [1]);
  assert.equal(resumed.snapshot.summary.active, 3);
  assert.equal(resumed.snapshot.summary.queued, 1);
  assert.equal(activeAndPaused(resumed.snapshot), 3);

  await harness.emitDownloadChange(1, {
    state: "complete",
    bytesReceived: 2048,
    totalBytes: 2048,
    filename: "/Users/tester/Downloads/AnyDownload/example.test/rewritten-by-firefox.jpg"
  });
  await waitFor(
    () => harness.downloadCalls.length === 4,
    "Completing one download must advance the queued item"
  );

  dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  assert.equal(dashboard.snapshot.summary.complete, 1);
  assert.equal(dashboard.snapshot.summary.active, 3);
  assert.equal(dashboard.snapshot.summary.queued, 0);
  assert.equal(dashboard.snapshot.stats.lifetime.completed, 1);
  assert.equal(dashboard.snapshot.stats.lifetime.bytes, 2048);
  assert.equal(dashboard.snapshot.stats.today.completed, 1);
  assert.equal(dashboard.snapshot.stats.today.bytes, 2048);

  const persisted = JSON.stringify(harness.local.dump());
  assert.doesNotMatch(persisted, /\/Users\/tester/);
  assert.match(persisted, /rewritten-by-firefox\.jpg/);
}

async function testDirectVideoSingleAndBulkPassthrough() {
  const single = createHarness();
  const singleResponse = await single.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/videos",
    saveAs: true,
    pageTitle: "Video page",
    pageUrl: "https://example.test/videos",
    items: [{
      url: "https://media.example.test/direct/feature.mp4?token=keep",
      filename: "feature.mp4",
      mediaType: "video"
    }]
  });
  assert.equal(singleResponse.ok, true);
  assert.equal(singleResponse.queued, 1);
  assert.equal(single.downloadCalls.length, 1);
  assert.equal(
    single.downloadCalls[0].url,
    "https://media.example.test/direct/feature.mp4?token=keep"
  );
  assert.equal(single.downloadCalls[0].filename, "AnyDownload/videos/feature.mp4");
  assert.equal(single.downloadCalls[0].saveAs, true, "Single-video Save As must remain available");

  const bulk = createHarness();
  const bulkResponse = await bulk.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/video-bulk",
    saveAs: true,
    items: [
      {
        url: "https://media.example.test/direct/first.webm?signature=keep",
        filename: "first.webm",
        mediaType: "video"
      },
      {
        url: "https://media.example.test/direct/second.mov",
        filename: "second.mov",
        mediaType: "video"
      },
      {
        url: "data:video/mp4;base64,AQID",
        filename: "embedded.mp4",
        mediaType: "video"
      }
    ]
  });
  assert.equal(bulkResponse.ok, true);
  assert.equal(bulkResponse.queued, 3);
  assert.equal(bulk.downloadCalls.length, 3);
  assert.deepEqual(
    bulk.downloadCalls.slice(0, 2).map((call) => call.url),
    [
      "https://media.example.test/direct/first.webm?signature=keep",
      "https://media.example.test/direct/second.mov"
    ],
    "Bulk direct video URLs must reach Firefox without rewriting"
  );
  assert.deepEqual(
    bulk.downloadCalls.map((call) => call.filename),
    ["first.webm", "second.mov", "embedded.mp4"]
      .map((name) => `AnyDownload/video-bulk/${name}`)
  );
  assert.ok(bulk.downloadCalls[2].url.startsWith("blob:anydownload-"));
  assert.equal(bulk.createdObjectUrls[0], bulk.downloadCalls[2].url);
  assert.ok(
    bulk.downloadCalls.every((call) => call.saveAs === false),
    "Save As applies only when exactly one media file is requested"
  );
  await bulk.emitDownloadChange(bulk.downloadCalls[2].id, {
    state: "complete",
    bytesReceived: 3,
    totalBytes: 3
  });
  await waitFor(
    () => bulk.revokedObjectUrls.includes(bulk.createdObjectUrls[0]),
    "An embedded video object URL must be released after Firefox finishes"
  );
}

async function testYouTubeProviderReferencesStayDurableAndRefreshOnRetry() {
  const videoId = "dQw4w9WgXcQ";
  const submittedUrl =
    "https://rr0---sn-test.googlevideo.com/videoplayback?itag=18&expire=1111111111&token=submitted-secret";
  const resolvedUrls = [
    "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18&expire=2222222222&token=fresh-first",
    "https://rr2---sn-test.googlevideo.com/videoplayback?itag=18&expire=3333333333&token=fresh-retry"
  ];
  const fetchCalls = [];
  const harness = createHarness({
    fetch: async (url, init) => {
      const callIndex = fetchCalls.length;
      fetchCalls.push({ url: String(url), init: copy(init) });
      const directUrl = resolvedUrls[Math.min(callIndex, resolvedUrls.length - 1)];
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            playabilityStatus: { status: "OK" },
            videoDetails: {
              videoId,
              title: "Durable YouTube queue fixture",
              lengthSeconds: "42"
            },
            streamingData: {
              formats: [{
                itag: 18,
                url: directUrl,
                mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
                width: 640,
                height: 360,
                qualityLabel: "360p"
              }]
            }
          });
        }
      };
    }
  });

  const accepted = await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/youtube",
    pageTitle: "Durable YouTube queue fixture",
    pageUrl: `https://www.youtube.com/watch?v=${videoId}`,
    items: [{
      url: submittedUrl,
      filename: "youtube-fixture.mp4",
      mediaType: "video"
    }]
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.queued, 1);
  assert.equal(fetchCalls.length, 1, "A claimed YouTube task must resolve one fresh direct URL");
  assert.equal(harness.downloadCalls[0].url, resolvedUrls[0]);

  let stored = harness.local.dump()[QUEUE_STORAGE_KEY];
  const durableUrl = new URL(stored.jobs[0].tasks[0].url);
  assert.equal(durableUrl.origin, "https://www.youtube.com");
  assert.equal(durableUrl.pathname, "/watch");
  assert.equal(durableUrl.searchParams.get("v"), videoId);
  assert.equal(durableUrl.searchParams.get("anydownload_provider"), "youtube");
  assert.equal(durableUrl.searchParams.get("anydownload_itag"), "18");
  assert.deepEqual(
    Array.from(durableUrl.searchParams.keys()).sort(),
    ["anydownload_itag", "anydownload_provider", "v"],
    "Only the public video identity and selected itag may be durable"
  );
  const persistedText = JSON.stringify(harness.local.dump());
  assert.doesNotMatch(persistedText, /googlevideo\.com/i);
  assert.doesNotMatch(persistedText, /submitted-secret|fresh-first|fresh-retry/);

  const firstDownloadId = harness.downloadCalls[0].id;
  await harness.emitDownloadChange(firstDownloadId, {
    state: "interrupted",
    error: "NETWORK_FAILED"
  });
  await waitFor(() => {
    const state = harness.local.dump()[QUEUE_STORAGE_KEY];
    return state && state.jobs[0].tasks[0].status === "interrupted";
  }, "The interrupted YouTube download must become retryable");

  const dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  const taskId = dashboard.snapshot.jobs[0].tasks[0].id;
  const retried = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "retry",
    targetType: "task",
    id: taskId,
    incognito: false
  });
  assert.equal(retried.ok, true);
  assert.equal(fetchCalls.length, 2, "Retry must re-resolve instead of reusing an expiring media URL");
  assert.equal(harness.downloadCalls.length, 2);
  assert.equal(harness.downloadCalls[1].url, resolvedUrls[1]);
  stored = harness.local.dump()[QUEUE_STORAGE_KEY];
  assert.equal(stored.jobs[0].tasks[0].url, durableUrl.href);
  assert.doesNotMatch(JSON.stringify(stored), /googlevideo\.com|fresh-first|fresh-retry/);
}

async function testInstagramDownloadsCarryOnlyCanonicalReferer() {
  const harness = createHarness();
  const response = await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/instagram",
    pageTitle: "Instagram post",
    pageUrl: "https://www.instagram.com/p/Fixture123/",
    items: [
      {
        url: "https://scontent.cdninstagram.com/v/t51.29350-15/photo.jpg?token=one",
        filename: "photo.jpg",
        mediaType: "image"
      },
      {
        url: "https://scontent.cdninstagram.com/o1/v/t16/video.mp4?token=two",
        filename: "video.mp4",
        mediaType: "video"
      }
    ]
  });
  assert.equal(response.ok, true);
  assert.equal(response.queued, 2);
  assert.equal(harness.downloadCalls.length, 2);
  for (const call of harness.downloadCalls) {
    assert.deepEqual(call.headers, [
      { name: "Referer", value: "https://www.instagram.com/" }
    ]);
  }
}

async function testNormalAndPrivateStorageIsolation() {
  const harness = createHarness();
  await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/public",
    items: [{ url: "https://public.example/image.jpg", filename: "public.jpg" }]
  });
  await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/private",
    incognito: true,
    items: [{ url: "https://private-secret.example/image.jpg", filename: "secret.jpg" }]
  });

  const localText = JSON.stringify(harness.local.dump());
  const sessionText = JSON.stringify(harness.session.dump());
  assert.match(localText, /public\.example/);
  assert.doesNotMatch(localText, /private-secret\.example/);
  assert.match(sessionText, /private-secret\.example/);
  assert.doesNotMatch(sessionText, /public\.example/);
  assert.deepEqual(harness.downloadCalls.map((call) => call.incognito), [false, true]);

  const normal = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  const privateDashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: true });
  assert.equal(normal.snapshot.summary.total, 1);
  assert.equal(privateDashboard.snapshot.summary.total, 1);
}

async function testPersistedRestartRecovery() {
  const first = createHarness();
  await first.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/restart",
    pageTitle: "Restart gallery",
    items: Array.from({ length: 5 }, (_, index) => ({
      url: `https://restart.example/${index + 1}.jpg`,
      filename: `restart-${index + 1}.jpg`
    }))
  });
  assert.equal(first.downloadCalls.length, 3);

  const local = first.local.dump();
  const state = local[QUEUE_STORAGE_KEY];
  const activeTasks = state.jobs[0].tasks.filter((task) => task.status === "in_progress");
  assert.equal(activeTasks.length, 3);
  const stranded = activeTasks[0];
  const strandedDownloadId = stranded.downloadId;
  stranded.status = "starting";
  stranded.downloadId = null;

  const retainedDownloads = Array.from(first.downloads.values())
    .filter((item) => item.id !== strandedDownloadId)
    .map(copy);
  const transientId = retainedDownloads[0].id;
  const restarted = createHarness({
    local,
    downloads: retainedDownloads,
    searchFailures: [transientId]
  });
  await waitFor(
    () => restarted.downloadCalls.length === 1,
    "Background evaluation must recover an unbound starting task and refill the free queue slot"
  );

  const dashboard = await restarted.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  assert.equal(dashboard.snapshot.summary.active, 3);
  assert.equal(dashboard.snapshot.summary.queued, 2);
  assert.equal(dashboard.snapshot.summary.failed, 0, "A transient search failure must not lose a download");
  assert.equal(restarted.downloadCalls[0].filename, "AnyDownload/restart/restart-1.jpg");
  assert.doesNotMatch(JSON.stringify(restarted.local.dump()), /\/Users\/tester/);
}

async function testStorageFailuresDoNotCorruptSchedulerState() {
  const rejectedAcceptance = createHarness();
  await rejectedAcceptance.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  rejectedAcceptance.failNextLocalSet((values) => {
    const state = values[QUEUE_STORAGE_KEY];
    return state && state.jobs.some((job) =>
      job.tasks.some((task) => task.status === "queued" && task.downloadId === null)
    );
  }, "Synthetic queue acceptance failure");
  await assert.rejects(rejectedAcceptance.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/rejected-acceptance",
    items: [{ url: "https://storage.example/rejected.jpg", filename: "rejected.jpg" }]
  }), /queue acceptance failure/);
  let dashboard = await rejectedAcceptance.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false
  });
  assert.equal(rejectedAcceptance.downloadCalls.length, 0);
  assert.equal(dashboard.snapshot.summary.total, 0, "A rejected batch must not remain cached for later startup");

  const beforeStart = createHarness();
  await beforeStart.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  beforeStart.failNextLocalSet((values) => {
    const state = values[QUEUE_STORAGE_KEY];
    return state && state.jobs.some((job) =>
      job.tasks.some((task) => task.status === "starting" && task.downloadId === null)
    );
  }, "Synthetic pre-start persistence failure");
  const acceptedBeforeStart = await beforeStart.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/pre-start-storage-failure",
    items: [{ url: "https://storage.example/pre-start.jpg", filename: "pre-start.jpg" }]
  });
  assert.equal(acceptedBeforeStart.ok, true);
  assert.equal(acceptedBeforeStart.queued, 1);
  assert.match(acceptedBeforeStart.warning, /pre-start persistence failure/);
  assert.equal(beforeStart.downloadCalls.length, 0, "No native download may start before the claim is durable");

  dashboard = await beforeStart.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false
  });
  assert.equal(beforeStart.downloadCalls.length, 1, "A later operation must retry the rolled-back queued task");
  assert.equal(dashboard.snapshot.summary.active, 1);
  assert.equal(dashboard.snapshot.jobs[0].tasks[0].status, "in_progress");

  const afterStart = createHarness();
  await afterStart.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  afterStart.failNextLocalSet((values) => {
    const state = values[QUEUE_STORAGE_KEY];
    return state && state.jobs.some((job) =>
      job.tasks.some((task) => task.status === "in_progress" && Number.isInteger(task.downloadId))
    );
  }, "Synthetic post-bind persistence failure");
  const acceptedAfterStart = await afterStart.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/post-bind-storage-failure",
    items: [
      { url: "data:image/png;base64,AQID", filename: "embedded.png" },
      { url: "https://storage.example/second.jpg", filename: "second.jpg" },
      { url: "https://storage.example/third.jpg", filename: "third.jpg" },
      { url: "https://storage.example/fourth.jpg", filename: "fourth.jpg" }
    ]
  });
  assert.equal(acceptedAfterStart.ok, true, "A durably queued batch must remain accepted after a bind write fails");
  assert.equal(acceptedAfterStart.queued, 4);
  assert.match(acceptedAfterStart.warning, /post-bind persistence failure/);
  assert.equal(afterStart.downloadCalls.length, 1, "An accepted native download must not be started twice");
  assert.equal(afterStart.createdObjectUrls.length, 1);
  assert.equal(
    afterStart.revokedObjectUrls.includes(afterStart.createdObjectUrls[0]),
    false,
    "A live data-download object URL must survive a post-bind persistence failure"
  );

  dashboard = await afterStart.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  assert.equal(afterStart.downloadCalls.length, 3, "Recovered work must fill only the remaining queue slots");
  assert.equal(dashboard.snapshot.summary.active, 3);
  assert.equal(dashboard.snapshot.summary.queued, 1);
  assert.equal(dashboard.snapshot.summary.failed, 0);
  assert.ok(
    dashboard.snapshot.jobs[0].tasks.every((task) => task.status !== "starting"),
    "Unstarted claims must return to queued state when post-bind persistence fails"
  );
  const stored = afterStart.local.dump()[QUEUE_STORAGE_KEY];
  const embeddedTask = stored.jobs[0].tasks.find((task) => task.filename === "embedded.png");
  assert.equal(embeddedTask.status, "in_progress");
  assert.equal(embeddedTask.downloadId, afterStart.downloadCalls[0].id);

  await afterStart.emitDownloadChange(afterStart.downloadCalls[0].id, {
    state: "complete",
    bytesReceived: 3,
    totalBytes: 3
  });
  assert.ok(
    afterStart.revokedObjectUrls.includes(afterStart.createdObjectUrls[0]),
    "The retained object URL must still be released when Firefox finishes"
  );
}

async function testMissedDownloadEventsPersistDuringDashboardReconciliation() {
  const harness = createHarness();
  await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/missed-events",
    pageTitle: "Missed event test",
    items: [{ url: "https://missed.example/photo.jpg", filename: "photo.jpg" }]
  });
  let dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  const task = dashboard.snapshot.jobs[0].tasks[0];
  const nativeItem = harness.downloads.get(task.downloadId);

  nativeItem.paused = true;
  nativeItem.bytesReceived = 512;
  nativeItem.totalBytes = 1024;
  dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  assert.equal(dashboard.snapshot.summary.paused, 1);
  assert.equal(dashboard.snapshot.jobs[0].tasks[0].bytesReceived, 512);
  let stored = harness.local.dump()[QUEUE_STORAGE_KEY];
  assert.equal(stored.jobs[0].tasks[0].status, "paused");
  assert.equal(stored.jobs[0].tasks[0].bytesReceived, 512);
  assert.equal(stored.jobs[0].tasks[0].totalBytes, 1024);

  const endTime = Math.max(stored.jobs[0].tasks[0].createdAt, Date.now());
  nativeItem.state = "complete";
  nativeItem.paused = false;
  nativeItem.bytesReceived = 1024;
  nativeItem.totalBytes = 1024;
  nativeItem.endTime = new Date(endTime).toISOString();
  dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  assert.equal(dashboard.snapshot.summary.complete, 1);
  assert.equal(dashboard.snapshot.stats.lifetime.completed, 1);
  assert.equal(dashboard.snapshot.stats.lifetime.bytes, 1024);
  stored = harness.local.dump()[QUEUE_STORAGE_KEY];
  assert.equal(stored.jobs[0].tasks[0].status, "complete");
  assert.equal(stored.jobs[0].tasks[0].completedAt, endTime);
  assert.equal(stored.stats.lifetime.completed, 1);
  assert.equal(stored.stats.lifetime.bytesDownloaded, 1024);
  assert.equal(stored.history[0].finishedAt, endTime);
  assert.equal(stored.history[0].bytesDownloaded, 1024);
}

async function testPauseResumeCancelRetryHistoryAndClear() {
  const harness = createHarness();
  await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/controls",
    pageTitle: "Control test",
    items: [{ url: "https://controls.example/photo.jpg", filename: "controlled-photo.jpg" }]
  });
  let dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  const task = dashboard.snapshot.jobs[0].tasks[0];
  const originalDownloadId = task.downloadId;

  let action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "task",
    id: task.id,
    incognito: false
  });
  assert.equal(action.snapshot.summary.paused, 1);
  assert.deepEqual(harness.pauseCalls, [originalDownloadId]);

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "resume",
    targetType: "job",
    id: dashboard.snapshot.jobs[0].id,
    incognito: false
  });
  assert.equal(action.snapshot.summary.active, 1);
  assert.deepEqual(harness.resumeCalls, [originalDownloadId]);

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "cancel",
    targetType: "task",
    id: task.id,
    incognito: false
  });
  assert.equal(action.snapshot.summary.cancelled, 1);
  assert.deepEqual(harness.cancelCalls, [originalDownloadId]);
  assert.equal(action.snapshot.stats.lifetime.cancelled, 1);

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "retry",
    targetType: "task",
    id: task.id,
    incognito: false
  });
  assert.equal(action.snapshot.summary.active, 1);
  assert.equal(harness.downloadCalls.length, 2);
  assert.equal(action.snapshot.jobs[0].tasks[0].attempt, 2);
  const retryDownloadId = action.snapshot.jobs[0].tasks[0].downloadId;

  // Force the terminal-event fallback path: even when downloads.search fails,
  // Firefox's absolute filename must be reduced to a safe leaf before storage.
  harness.searchFailures.add(retryDownloadId);
  await harness.emitDownloadChange(retryDownloadId, {
    state: "complete",
    bytesReceived: 4096,
    totalBytes: 4096,
    filename: "/Users/tester/Downloads/AnyDownload/controls/controlled-photo.jpg"
  });
  await waitFor(
    () => {
      const stored = harness.local.dump()[QUEUE_STORAGE_KEY];
      return stored && stored.stats.lifetime.completed === 1;
    },
    "Retry completion must be reflected in persisted statistics"
  );

  dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  assert.equal(dashboard.snapshot.summary.complete, 1);
  assert.equal(dashboard.snapshot.stats.lifetime.completed, 1);
  assert.equal(dashboard.snapshot.stats.lifetime.cancelled, 1);
  assert.equal(dashboard.snapshot.stats.lifetime.bytes, 4096);
  const persistedBeforeClear = harness.local.dump()[QUEUE_STORAGE_KEY];
  assert.equal(persistedBeforeClear.history.length, 1, "A finished job must be retained in history");

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "clear_completed",
    targetType: "all",
    id: "",
    incognito: false
  });
  assert.equal(
    action.snapshot.summary.total,
    1,
    "Clear must retain a completed row while Firefox metadata is still unavailable"
  );
  harness.searchFailures.delete(retryDownloadId);
  await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "clear_completed",
    targetType: "all",
    id: "",
    incognito: false
  });
  assert.equal(action.snapshot.summary.total, 0);
  assert.equal(action.snapshot.jobs.length, 1);
  assert.equal(action.snapshot.jobs[0].historyOnly, true);
  assert.equal(action.snapshot.jobs[0].tasks.length, 0);
  assert.equal(action.snapshot.stats.lifetime.completed, 1, "Clearing rows must preserve statistics");
  assert.equal(action.snapshot.stats.lifetime.cancelled, 1);
  assert.doesNotMatch(JSON.stringify(harness.local.dump()), /\/Users\/tester/);
}

async function testBoundControlsRequireNativeApiSuccess() {
  const unavailable = createHarness();
  await unavailable.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/unavailable-controls",
    items: Array.from({ length: 4 }, (_value, index) => ({
      url: `https://controls-unavailable.example/${index + 1}.jpg`,
      filename: `unavailable-${index + 1}.jpg`
    }))
  });
  let dashboard = await unavailable.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false
  });
  const activeTasks = dashboard.snapshot.jobs[0].tasks.filter((task) => task.status === "in_progress");
  const queuedTask = dashboard.snapshot.jobs[0].tasks.find((task) => task.status === "queued");
  const pauseApi = unavailable.browser.downloads.pause;
  delete unavailable.browser.downloads.pause;

  let action = await unavailable.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "task",
    id: activeTasks[0].id,
    incognito: false
  });
  assert.equal(action.ok, false);
  assert.match(action.error, /pause API is unavailable/);
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === activeTasks[0].id).status, "in_progress");
  assert.equal(unavailable.pauseCalls.length, 0);

  action = await unavailable.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "task",
    id: queuedTask.id,
    incognito: false
  });
  assert.equal(action.ok, true, "An unbound queued task must pause without a native API");
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === queuedTask.id).status, "paused");

  delete unavailable.browser.downloads.resume;
  action = await unavailable.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "resume",
    targetType: "task",
    id: queuedTask.id,
    incognito: false
  });
  assert.equal(action.ok, true, "An unbound paused task must resume without a native API");
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === queuedTask.id).status, "queued");

  delete unavailable.browser.downloads.cancel;
  action = await unavailable.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "cancel",
    targetType: "task",
    id: activeTasks[1].id,
    incognito: false
  });
  assert.equal(action.ok, false);
  assert.match(action.error, /cancel API is unavailable/);
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === activeTasks[1].id).status, "in_progress");
  assert.equal(unavailable.cancelCalls.length, 0);

  action = await unavailable.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "cancel",
    targetType: "task",
    id: queuedTask.id,
    incognito: false
  });
  assert.equal(action.ok, true, "An unbound task must cancel without a native API");
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === queuedTask.id).status, "cancelled");

  unavailable.browser.downloads.pause = pauseApi;
  action = await unavailable.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "task",
    id: activeTasks[2].id,
    incognito: false
  });
  assert.equal(action.ok, true);
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === activeTasks[2].id).status, "paused");
  action = await unavailable.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "resume",
    targetType: "task",
    id: activeTasks[2].id,
    incognito: false
  });
  assert.equal(action.ok, false);
  assert.match(action.error, /resume API is unavailable/);
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === activeTasks[2].id).status, "paused");

  const rejecting = createHarness();
  await rejecting.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/rejected-controls",
    items: Array.from({ length: 3 }, (_value, index) => ({
      url: `https://controls-rejected.example/${index + 1}.jpg`,
      filename: `rejected-${index + 1}.jpg`
    }))
  });
  dashboard = await rejecting.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  const rejectedTasks = dashboard.snapshot.jobs[0].tasks;

  rejecting.rejectingDownloadApis.add("pause");
  action = await rejecting.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "task",
    id: rejectedTasks[0].id,
    incognito: false
  });
  assert.equal(action.ok, false);
  assert.match(action.error, /Synthetic pause failure/);
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === rejectedTasks[0].id).status, "in_progress");
  assert.equal(rejecting.downloads.get(rejectedTasks[0].downloadId).paused, false);

  rejecting.rejectingDownloadApis.delete("pause");
  action = await rejecting.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "task",
    id: rejectedTasks[1].id,
    incognito: false
  });
  assert.equal(action.ok, true);
  rejecting.rejectingDownloadApis.add("resume");
  action = await rejecting.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "resume",
    targetType: "task",
    id: rejectedTasks[1].id,
    incognito: false
  });
  assert.equal(action.ok, false);
  assert.match(action.error, /Synthetic resume failure/);
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === rejectedTasks[1].id).status, "paused");
  assert.equal(rejecting.downloads.get(rejectedTasks[1].downloadId).paused, true);

  rejecting.rejectingDownloadApis.add("cancel");
  action = await rejecting.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "cancel",
    targetType: "task",
    id: rejectedTasks[2].id,
    incognito: false
  });
  assert.equal(action.ok, false);
  assert.match(action.error, /Synthetic cancel failure/);
  assert.equal(action.snapshot.jobs[0].tasks.find((task) => task.id === rejectedTasks[2].id).status, "in_progress");
  assert.equal(rejecting.downloads.get(rejectedTasks[2].downloadId).state, "in_progress");
}

async function testTerminalMetadataReconciliation() {
  const harness = createHarness();
  await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/reconcile",
    pageTitle: "Reconciliation test",
    items: [{ url: "https://reconcile.example/photo.jpg", filename: "photo.jpg" }]
  });
  const initial = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  const downloadId = initial.snapshot.jobs[0].tasks[0].downloadId;
  harness.searchFailures.add(downloadId);
  await harness.emitDownloadChange(downloadId, { state: "complete" });
  await waitFor(() => {
    const stored = harness.local.dump()[QUEUE_STORAGE_KEY];
    return stored && stored.jobs[0].tasks[0].needsReconciliation === true;
  }, "A terminal fallback must be persisted for later metadata reconciliation");

  let stored = harness.local.dump()[QUEUE_STORAGE_KEY];
  assert.equal(stored.stats.lifetime.completed, 1);
  assert.equal(stored.stats.lifetime.bytesDownloaded, 0);
  const nativeItem = harness.downloads.get(downloadId);
  nativeItem.bytesReceived = 8192;
  nativeItem.totalBytes = 8192;
  nativeItem.filename = "/Users/tester/Downloads/AnyDownload/reconcile/final-photo.jpg";
  harness.searchFailures.delete(downloadId);

  const reconciled = await harness.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false
  });
  assert.equal(reconciled.snapshot.stats.lifetime.completed, 1);
  assert.equal(reconciled.snapshot.stats.lifetime.bytes, 8192);
  assert.equal(reconciled.snapshot.stats.today.bytes, 8192);
  assert.equal(reconciled.snapshot.jobs[0].tasks[0].filename, "final-photo.jpg");
  stored = harness.local.dump()[QUEUE_STORAGE_KEY];
  assert.equal(stored.jobs[0].tasks[0].needsReconciliation, false);
  assert.equal(stored.history[0].bytesDownloaded, 8192);
  assert.doesNotMatch(JSON.stringify(stored), /\/Users\/tester/);
}

async function testStartFailuresDoNotStrandQueuedItems() {
  const partiallyFailing = createHarness({ rejectFirstDownloads: 13 });
  await partiallyFailing.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/start-failures",
    items: Array.from({ length: 16 }, (_value, index) => ({
      url: `https://start-failures.example/${index}.jpg`,
      filename: `photo-${index}.jpg`
    }))
  });
  let dashboard = await partiallyFailing.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false
  });
  assert.equal(partiallyFailing.downloadCalls.length, 16);
  assert.equal(dashboard.snapshot.summary.failed, 13);
  assert.equal(dashboard.snapshot.summary.active, 3);
  assert.equal(dashboard.snapshot.summary.queued, 0);

  const fullyFailing = createHarness({ rejectFirstDownloads: 20 });
  await fullyFailing.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/all-start-failures",
    items: Array.from({ length: 20 }, (_value, index) => ({
      url: `https://all-start-failures.example/${index}.jpg`,
      filename: `photo-${index}.jpg`
    }))
  });
  dashboard = await fullyFailing.send({
    type: "GET_DOWNLOAD_DASHBOARD",
    incognito: false
  });
  assert.equal(fullyFailing.downloadCalls.length, 20);
  assert.equal(dashboard.snapshot.summary.failed, 20);
  assert.equal(dashboard.snapshot.summary.active, 0);
  assert.equal(dashboard.snapshot.summary.queued, 0);
  const persistedTasks = fullyFailing.local.dump()[QUEUE_STORAGE_KEY].jobs[0].tasks;
  assert.ok(persistedTasks.every((task) => task.status === "interrupted"));
}

async function testFinishedDetailsMakeRoomWithoutLosingHistory() {
  let queueState = DownloadQueue.emptyState(Date.UTC(2026, 7, 7));
  for (let index = 0; index < DownloadQueue.MAX_STORED_JOBS; index += 1) {
    const now = Date.UTC(2026, 7, 7) + index + 1;
    const enqueued = DownloadQueue.enqueueBatch(queueState, [{
      url: `https://finished.example/${index}.jpg`,
      filename: `finished-${index}.jpg`
    }], {
      now,
      label: `Finished ${index}`,
      folder: "AnyDownload/finished",
      idFactory(kind) {
        return `${kind}-finished-${index}`;
      }
    });
    queueState = enqueued.state;
    const task = queueState.jobs.find((job) => job.id === enqueued.jobId).tasks[0];
    queueState = DownloadQueue.interruptTask(queueState, task.id, "Synthetic failure", { now });
  }
  assert.equal(queueState.jobs.length, DownloadQueue.MAX_STORED_JOBS);
  assert.equal(queueState.history.length, DownloadQueue.MAX_HISTORY_ITEMS);
  const oldestJobId = queueState.jobs[0].id;

  const harness = createHarness({ local: { [QUEUE_STORAGE_KEY]: queueState } });
  const response = await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/new",
    pageTitle: "New batch",
    items: [{ url: "https://new.example/photo.jpg", filename: "new-photo.jpg" }]
  });
  assert.equal(response.ok, true);
  assert.equal(response.queued, 1);
  const stored = harness.local.dump()[QUEUE_STORAGE_KEY];
  assert.equal(stored.jobs.length, DownloadQueue.MAX_STORED_JOBS);
  assert.ok(!stored.jobs.some((job) => job.id === oldestJobId));
  assert.ok(stored.jobs.some((job) => job.label === "New batch"));
  assert.ok(stored.history.some((item) => item.jobId === oldestJobId));

  const dashboard = await harness.send({ type: "GET_DOWNLOAD_DASHBOARD", incognito: false });
  const compact = dashboard.snapshot.jobs.find((job) => job.id === oldestJobId);
  assert.ok(compact, "A pruned finished batch must remain as compact history");
  assert.equal(compact.historyOnly, true);
  assert.equal(compact.tasks.length, 0);
}

async function testBulkControlsAtQueueLimit() {
  const harness = createHarness();
  const response = await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/large-controls",
    pageTitle: "Large controls",
    items: Array.from({ length: 1500 }, (_value, index) => ({
      url: `https://large-controls.example/${index}.jpg`,
      filename: `large-${index}.jpg`
    }))
  });
  assert.equal(response.queued, 1500);
  assert.equal(harness.downloadCalls.length, 3);

  let action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "pause",
    targetType: "all",
    id: "",
    incognito: false
  });
  assert.equal(action.snapshot.summary.paused, 1500);
  assert.equal(harness.pauseCalls.length, 3);
  assert.equal(harness.downloadCalls.length, 3);

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "resume",
    targetType: "all",
    id: "",
    incognito: false
  });
  assert.equal(action.snapshot.summary.active, 3);
  assert.equal(action.snapshot.summary.queued, 1497);
  assert.equal(harness.resumeCalls.length, 3);
  assert.equal(harness.downloadCalls.length, 3, "Bulk resume must respect concurrency");

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "cancel",
    targetType: "all",
    id: "",
    incognito: false
  });
  assert.equal(action.snapshot.summary.cancelled, 1500);
  assert.equal(action.snapshot.stats.lifetime.cancelled, 1500);
  assert.equal(harness.cancelCalls.length, 3);
}

async function testBulkRetryLeavesCancelledTasksAlone() {
  const baseTime = Date.now() - 10000;
  let state = DownloadQueue.emptyState(baseTime);
  const mixedResult = DownloadQueue.enqueueBatch(state, [
    { url: "https://retry-scope.example/interrupted.jpg", filename: "interrupted.jpg" },
    { url: "https://retry-scope.example/cancelled.jpg", filename: "cancelled.jpg" }
  ], {
    now: baseTime,
    folder: "AnyDownload/retry-scope",
    label: "Mixed retry scope",
    idFactory(kind, index) {
      return `${kind}-mixed-${index}`;
    }
  });
  state = mixedResult.state;
  const mixedJob = state.jobs.find((job) => job.id === mixedResult.jobId);
  const interruptedTaskId = mixedJob.tasks[0].id;
  const cancelledTaskId = mixedJob.tasks[1].id;
  state = DownloadQueue.interruptTask(state, interruptedTaskId, "Synthetic failure", {
    now: baseTime + 1
  });
  state = DownloadQueue.cancelTask(state, cancelledTaskId, {
    now: baseTime + 2
  });

  const cancelledResult = DownloadQueue.enqueueBatch(state, [{
    url: "https://retry-scope.example/cancelled-job.jpg",
    filename: "cancelled-job.jpg"
  }], {
    now: baseTime + 3,
    folder: "AnyDownload/retry-scope",
    label: "Cancelled job",
    idFactory(kind, index) {
      return `${kind}-cancelled-${index}`;
    }
  });
  state = cancelledResult.state;
  const cancelledJob = state.jobs.find((job) => job.id === cancelledResult.jobId);
  const otherCancelledTaskId = cancelledJob.tasks[0].id;
  state = DownloadQueue.cancelTask(state, otherCancelledTaskId, {
    now: baseTime + 4
  });

  const harness = createHarness({ local: { [QUEUE_STORAGE_KEY]: state } });
  let action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "retry",
    targetType: "job",
    id: mixedResult.jobId,
    incognito: false
  });
  assert.equal(harness.downloadCalls.length, 1, "Job retry must restart only interrupted tasks");
  let tasks = action.snapshot.jobs.flatMap((job) => job.tasks);
  assert.equal(tasks.find((task) => task.id === interruptedTaskId).status, "in_progress");
  assert.equal(tasks.find((task) => task.id === cancelledTaskId).status, "cancelled");

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "retry",
    targetType: "all",
    id: "",
    incognito: false
  });
  assert.equal(harness.downloadCalls.length, 1, "Retry all must not restart cancelled tasks");
  tasks = action.snapshot.jobs.flatMap((job) => job.tasks);
  assert.equal(tasks.find((task) => task.id === cancelledTaskId).status, "cancelled");
  assert.equal(tasks.find((task) => task.id === otherCancelledTaskId).status, "cancelled");

  action = await harness.send({
    type: "DOWNLOAD_QUEUE_ACTION",
    action: "retry",
    targetType: "task",
    id: cancelledTaskId,
    incognito: false
  });
  assert.equal(harness.downloadCalls.length, 2, "An explicit task retry may restart a cancelled task");
  tasks = action.snapshot.jobs.flatMap((job) => job.tasks);
  assert.equal(tasks.find((task) => task.id === cancelledTaskId).status, "in_progress");
  assert.equal(tasks.find((task) => task.id === cancelledTaskId).attempt, 2);
  assert.equal(tasks.find((task) => task.id === otherCancelledTaskId).status, "cancelled");
}

async function testProgressEventsAvoidDurableWriteAmplification() {
  const harness = createHarness();
  await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/progress-writes",
    items: [{
      url: "https://progress.example/photo.jpg",
      filename: "photo.jpg"
    }]
  });

  const writesBeforeProgress = harness.local.setCallCount;
  await harness.emitDownloadChange(1, {
    bytesReceived: 512,
    totalBytes: 4096
  });
  assert.equal(
    harness.local.setCallCount,
    writesBeforeProgress,
    "A byte-only progress event must not rewrite the full durable queue"
  );
  assert.equal(
    harness.local.dump()[QUEUE_STORAGE_KEY].jobs[0].tasks[0].bytesReceived,
    0,
    "Transient progress can remain in memory until reconciliation"
  );

  await harness.emitDownloadChange(1, {
    state: "complete",
    bytesReceived: 4096,
    totalBytes: 4096
  });
  assert.ok(
    harness.local.setCallCount > writesBeforeProgress,
    "A terminal event must still persist queue and ledger state immediately"
  );
  assert.equal(
    harness.local.dump()[QUEUE_STORAGE_KEY].jobs[0].tasks[0].bytesReceived,
    4096
  );
}

async function testCompletedDownloadLedgerAndStatusLookup() {
  const harness = createHarness();
  const queued = await harness.send({
    type: "DOWNLOAD_BATCH",
    folder: "AnyDownload/ledger",
    pageTitle: "Ledger gallery",
    pageUrl: "https://gallery.example.test/page",
    items: [{
      url: "https://cdn.example.test/photo.jpg?size=large&token=first&expires=100",
      filename: "photo.jpg",
      identityKey: "gallery-photo-1"
    }]
  });
  assert.equal(queued.ok, true);

  let status = await harness.send({
    type: "GET_MEDIA_DOWNLOAD_STATUS",
    pageUrl: "https://gallery.example.test/other",
    incognito: false,
    items: [{
      url: "https://cdn.example.test/refreshed.jpg?token=second",
      identityKey: "gallery-photo-1"
    }]
  });
  assert.equal(status.ok, true);
  assert.equal(status.statuses[0].status, "queued");
  assert.match(status.statuses[0].fingerprint, /^[a-f0-9]{16}$/);

  await harness.emitDownloadChange(1, {
    state: "complete",
    bytesReceived: 4096,
    totalBytes: 4096,
    filename: "/Users/tester/Downloads/AnyDownload/ledger/final-photo.jpg"
  });
  await waitFor(
    () => Boolean(harness.local.dump()["downloadLedger:v1"]),
    "A completed queue task must be written to the download ledger"
  );

  status = await harness.send({
    type: "GET_MEDIA_DOWNLOAD_STATUS",
    pageUrl: "https://gallery.example.test/page-two",
    incognito: false,
    items: [{
      url: "https://cdn.example.test/another-signed-url.jpg?expires=999",
      identityKey: "gallery-photo-1"
    }]
  });
  assert.equal(status.statuses[0].status, "downloaded");
  assert.equal(status.statuses[0].filename, "final-photo.jpg");
  assert.ok(status.statuses[0].completedAt > 0);

  const ledgerJson = JSON.stringify(harness.local.dump()["downloadLedger:v1"]);
  assert.doesNotMatch(ledgerJson, /cdn\.example\.test|token=|expires=/, "The ledger must store fingerprints rather than media URLs");
  const privateStatus = await harness.send({
    type: "GET_MEDIA_DOWNLOAD_STATUS",
    pageUrl: "https://gallery.example.test/page",
    incognito: true,
    items: [{
      url: "https://cdn.example.test/photo.jpg",
      identityKey: "gallery-photo-1"
    }]
  });
  assert.equal(privateStatus.statuses[0].status, "new", "Normal completion state must not leak into private windows");
}

async function testTelegramSourceTransfer() {
  const harness = createHarness({ nativeBlob: true });
  const page = "https://web.telegram.org/k/#-123";
  const source = "blob:https://web.telegram.org/01234567-abcd-1234-abcd-012345678901";
  harness.browser.tabs.query = async () => [{ id: 77, url: page, incognito: false }];
  harness.browser.tabs.get = async (id) => ({ id, url: page, incognito: false });
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  harness.browser.scripting.executeScript = async (options) => {
    assert.equal(options.target.tabId, 77);
    assert.equal(options.world, "MAIN");
    assert.deepEqual(Array.from(options.args), [source, page, 0]);
    return [{ result: { data: bytes.toString("base64"), total: bytes.length, type: "image/jpeg" } }];
  };
  const result = await harness.send({ type: "DOWNLOAD_BATCH", pageUrl: page,
    folder: "Telegram", items: [{ url: source, filename: "photo.jpg", mediaType: "image" }] });
  assert.equal(result.ok, true);
  assert.equal(harness.downloadCalls.length, 1);
  assert.equal(harness.downloadCalls[0].url, harness.createdObjectUrls[0]);
  assert.notEqual(harness.downloadCalls[0].url, source, "Firefox must receive an extension-owned blob");
  assert.equal(harness.revokedObjectUrls.length, 0, "Retain bytes until native completion");
  await harness.emitDownloadChange(harness.downloadCalls[0].id, { state: "complete", bytesReceived: bytes.length });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(harness.revokedObjectUrls, harness.createdObjectUrls);
}

(async () => {
  await testTelegramSourceTransfer();
  const galleries = createHarness();
  const galleryMessage = { type: "SITE_GALLERY", siteKey: "https://gallery.test", epoch: 0 };
  await Promise.all(["first", "second"].map((name) => galleries.send({
    ...galleryMessage, action: "save", records: [{
      url: `https://cdn.test/${name}.jpg`, pageUrl: `https://gallery.test/${name}`, selected: true
    }]
  })));
  const savedGallery = await galleries.send({ ...galleryMessage, action: "get" });
  assert.equal(savedGallery.gallery.records.length, 2, "Concurrent tabs must retain both discoveries");
  const privateGallery = await galleries.send({ ...galleryMessage, action: "get", incognito: true });
  assert.equal(privateGallery.gallery.records.length, 0, "Normal galleries must not appear in private windows");
  await galleries.send({ ...galleryMessage, action: "save", incognito: true, records: [{
    url: "https://cdn.test/private.jpg", pageUrl: "https://gallery.test/private", selected: false
  }] });
  assert.doesNotMatch(JSON.stringify(galleries.local.dump()), /private\.jpg/);
  assert.match(JSON.stringify(galleries.session.dump()), /private\.jpg/);
  await galleries.send({ ...galleryMessage, action: "clear" });
  const staleGallery = await galleries.send({ ...galleryMessage, action: "save", records: savedGallery.gallery.records });
  assert.equal(staleGallery.stale, true, "A stale tab must not resurrect a cleared gallery");
  await testEmptyQueueReadsDoNotWriteStorage();
  await testQueueConcurrencyProgressAndStatistics();
  await testDirectVideoSingleAndBulkPassthrough();
  await testYouTubeProviderReferencesStayDurableAndRefreshOnRetry();
  await testInstagramDownloadsCarryOnlyCanonicalReferer();
  await testNormalAndPrivateStorageIsolation();
  await testPersistedRestartRecovery();
  await testStorageFailuresDoNotCorruptSchedulerState();
  await testMissedDownloadEventsPersistDuringDashboardReconciliation();
  await testPauseResumeCancelRetryHistoryAndClear();
  await testBoundControlsRequireNativeApiSuccess();
  await testTerminalMetadataReconciliation();
  await testStartFailuresDoNotStrandQueuedItems();
  await testFinishedDetailsMakeRoomWithoutLosingHistory();
  await testBulkControlsAtQueueLimit();
  await testBulkRetryLeavesCancelledTasksAlone();
  await testProgressEventsAvoidDurableWriteAmplification();
  await testCompletedDownloadLedgerAndStatusLookup();
  console.log("All background queue integration checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
