"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const StoredZip = require("../extension/shared/archive.js");
const ArchivePage = require("../extension/archive/archive.js");

const archivePageSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/archive/archive.js"),
  "utf8"
);
const archiveHtml = fs.readFileSync(
  path.resolve(__dirname, "../extension/archive/archive.html"),
  "utf8"
);
const archiveCss = fs.readFileSync(
  path.resolve(__dirname, "../extension/archive/archive.css"),
  "utf8"
);

const browserContext = { TextEncoder };
vm.createContext(browserContext);
vm.runInContext(archivePageSource, browserContext);
assert.equal(
  typeof browserContext.ImageDownloaderArchivePage.planArchiveParts,
  "function",
  "The browser build must expose ImageDownloaderArchivePage"
);

assert.equal(ArchivePage.validateJobId("12345678"), "12345678");
assert.equal(ArchivePage.validateJobId("job-1234-ABCD"), "job-1234-ABCD");
assert.equal(ArchivePage.validateJobId("short"), "");
assert.equal(ArchivePage.validateJobId("unsafe/value"), "");
assert.equal(ArchivePage.validateJobId("a".repeat(81)), "");

const now = Date.now();
const twoThousandItems = Array.from({ length: 2000 }, (_value, index) => ({
  url: `https://images.example/photo-${index}.jpg`
}));
const validated = ArchivePage.validateArchiveRequest({
  createdAt: now,
  folder: "Website images/gallery",
  incognito: false,
  items: twoThousandItems
}, now);
assert.equal(validated.items.length, 2000);
assert.equal(validated.items[1999].originalIndex, 1999);
assert.equal(validated.items[0].filename, "photo-0.jpg");
assert.equal(validated.folder, "Website images/gallery");
assert.equal(validated.incognito, false);
assert.notEqual(validated.items, twoThousandItems, "Validation must return a defensive item list");

const customFilename = ArchivePage.validateArchiveRequest({
  createdAt: now,
  folder: "Website images/gallery",
  incognito: false,
  items: [{
    url: "https://images.example/source.jpg",
    filename: "Summer Gallery_0001.jpg"
  }]
}, now);
assert.equal(customFilename.items[0].filename, "Summer Gallery_0001.jpg");
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now,
    folder: "images",
    incognito: false,
    items: [{ url: "https://images.example/photo.jpg", filename: 7 }]
  }, now),
  /invalid filename/i
);

assert.throws(
  () => ArchivePage.validateArchiveRequest(null, now),
  /missing|used/i
);
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now,
    folder: "images",
    incognito: false,
    items: []
  }, now),
  /does not contain any images/i
);
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now,
    folder: "images",
    incognito: false,
    items: twoThousandItems.concat({ url: "https://images.example/overflow.jpg" })
  }, now),
  /at most 2000/i
);
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now - ArchivePage.MAX_ARCHIVE_AGE_MS - 1,
    folder: "images",
    incognito: false,
    items: [{ url: "https://images.example/photo.jpg" }]
  }, now),
  /expired/i
);
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now + 60001,
    folder: "images",
    incognito: false,
    items: [{ url: "https://images.example/photo.jpg" }]
  }, now),
  /expired/i
);
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now,
    folder: "../escape",
    incognito: false,
    items: [{ url: "https://images.example/photo.jpg" }]
  }, now),
  /cannot contain/i
);
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now,
    folder: "images",
    incognito: "false",
    items: [{ url: "https://images.example/photo.jpg" }]
  }, now),
  /browsing mode/i
);
assert.throws(
  () => ArchivePage.validateArchiveRequest({
    createdAt: now,
    folder: "images",
    incognito: false,
    items: [{ url: "file:///etc/passwd" }]
  }, now),
  /unsupported/i
);

assert.equal(ArchivePage.storedZipEntryFootprint("a.jpg", 10), 96);
assert.equal(
  ArchivePage.estimateStoredZipSize([{ name: "a.jpg", size: 10 }]),
  118
);

const planningEntries = Array.from({ length: 500 }, (_value, index) => ({
  name: `image-${String(index + 1).padStart(4, "0")}.jpg`,
  size: (index % 31) + 1,
  sequence: index
}));
const plannedParts = ArchivePage.planArchiveParts(planningEntries, 4096);
assert.ok(plannedParts.length > 10, "500 entries should be split into many small test parts");
assert.equal(
  plannedParts.flatMap((part) => part.entries).length,
  planningEntries.length
);
assert.deepEqual(
  plannedParts.flatMap((part) => part.entries).map((entry) => entry.sequence),
  planningEntries.map((entry) => entry.sequence),
  "Part planning must preserve input order"
);
for (const part of plannedParts) {
  assert.ok(part.size <= 4096, "No planned ZIP part may exceed its byte cap");
  const actual = StoredZip.createStoredZip(part.entries.map((entry) => ({
    name: entry.name,
    data: new Uint8Array(entry.size)
  })), { date: new Date(2024, 0, 1) });
  assert.equal(actual.size, part.size, "Planning must exactly match the stored ZIP writer");
}
assert.throws(
  () => ArchivePage.planArchiveParts([{ name: "huge.jpg", size: 4096 }], 4096),
  /cannot fit/i
);
assert.throws(
  () => ArchivePage.planArchiveParts([{ name: "bad.jpg", size: -1 }]),
  /non-negative/i
);

assert.equal(ArchivePage.archiveFilenameForFolder("Website images/gallery"), "gallery.zip");
assert.equal(ArchivePage.archiveFilenameForFolder("Website images/photos.zip"), "photos.zip");
const longArchiveName = ArchivePage.archiveFilenameForFolder(
  `Website images/${"a".repeat(100)}`
);
assert.equal(longArchiveName.length, 100);
assert.match(longArchiveName, /\.zip$/, "Long archive names must retain the .zip extension");
assert.equal(ArchivePage.archivePartFilename("gallery.zip", 1, false), "gallery.zip");
assert.equal(ArchivePage.archivePartFilename("gallery.zip", 1, true), "gallery-part-001.zip");
assert.equal(ArchivePage.archivePartFilename("gallery.zip", 27, true), "gallery-part-027.zip");
const longPartName = ArchivePage.archivePartFilename(`${"a".repeat(96)}.zip`, 27, true);
assert.equal(longPartName.length, 100);
assert.match(longPartName, /-part-027\.zip$/, "Long multipart names must retain the .zip extension");
assert.doesNotMatch(
  ArchivePage.archivePartFilename(`${"a".repeat(86)}😀.zip`, 1, true),
  /[\ud800-\udfff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
  "Multipart archive truncation must not split Unicode surrogate pairs"
);
assert.throws(() => ArchivePage.archivePartFilename("gallery.zip", 0, true), /positive/i);

assert.equal(ArchivePage.isClearlyNonImageContentType("image/jpeg"), false);
assert.equal(ArchivePage.isClearlyNonImageContentType("IMAGE/WEBP; charset=binary"), false);
assert.equal(ArchivePage.isClearlyNonImageContentType("application/octet-stream"), false);
assert.equal(ArchivePage.isClearlyNonImageContentType(""), false);
assert.equal(ArchivePage.isClearlyNonImageContentType("text/html; charset=utf-8"), true);
assert.equal(ArchivePage.isClearlyNonImageContentType("application/json"), true);

assert.equal(ArchivePage.formatBytes(0), "0 B");
assert.match(ArchivePage.formatBytes(1024), /1\s*KiB/);
assert.match(ArchivePage.formatBytes(64 * 1024 * 1024), /64\s*MiB/);

const report = ArchivePage.archiveErrorReport(Array.from({ length: 500 }, (_value, index) => ({
  index,
  filename: `photo-${index}.jpg`,
  url: `https://images.example/${"🐈".repeat(1000)}photo-${index}.jpg`,
  error: `HTTP 403 ${"🚫".repeat(1000)}`
})));
assert.ok(report instanceof Uint8Array);
assert.ok(report.byteLength <= 512 * 1024, "The in-archive failure report must stay bounded");
const reportText = new TextDecoder().decode(report);
assert.match(reportText, /AnyDownload could not archive/);
assert.match(reportText, /additional failure\(s\) were omitted/);

for (const id of [
  "byte-count",
  "cancel-button",
  "current-item",
  "downloads-list",
  "failure-count",
  "failures-list",
  "fatal-panel",
  "fetched-count",
  "job-progress",
  "total-count"
]) {
  assert.match(archiveHtml, new RegExp(`id=["']${id}["']`), `${id} must exist in Archive Progress`);
}
assert.ok(
  archiveHtml.indexOf("../shared/core.js") < archiveHtml.indexOf("../shared/archive.js") &&
  archiveHtml.indexOf("../shared/archive.js") < archiveHtml.indexOf("archive.js"),
  "Archive Progress scripts must load in dependency order"
);
assert.doesNotMatch(archiveHtml, /\son[a-z]+\s*=/i, "Archive Progress must not use inline event handlers");
assert.match(archiveCss, /@media\s*\(max-width:\s*480px\)/);
assert.match(archiveCss, /prefers-reduced-motion/);

class AbortSignalFixture {
  constructor() {
    this.aborted = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener, options) {
    if (type === "abort") {
      this.listeners.set(listener, Boolean(options && options.once));
    }
  }

  removeEventListener(type, listener) {
    if (type === "abort") {
      this.listeners.delete(listener);
    }
  }

  dispatchAbort() {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    for (const [listener, once] of Array.from(this.listeners.entries())) {
      listener();
      if (once) {
        this.listeners.delete(listener);
      }
    }
  }
}

class AbortControllerFixture {
  constructor() {
    this.signal = new AbortSignalFixture();
  }

  abort() {
    this.signal.dispatchAbort();
  }
}

class BlobFixture {
  constructor(parts, options) {
    this.parts = Array.from(parts || []);
    this.size = this.parts.reduce((total, part) => total + Number(part.byteLength || part.length || 0), 0);
    this.type = String(options && options.type || "");
  }
}

global.AbortController = AbortControllerFixture;
global.Blob = BlobFixture;
global.atob = (value) => Buffer.from(value, "base64").toString("binary");
const archiveObjectUrls = [];
const revokedArchiveObjectUrls = [];
URL.createObjectURL = (blob) => {
  const objectUrl = `blob:test-archive-${archiveObjectUrls.length + 1}`;
  archiveObjectUrls.push({ objectUrl, blob });
  return objectUrl;
};
URL.revokeObjectURL = (objectUrl) => {
  revokedArchiveObjectUrls.push(objectUrl);
};

class FakeElement {
  constructor() {
    this.children = [];
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.value = 0;
    this.max = 1;
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => current.add(name));
        this.className = Array.from(current).join(" ");
      }
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append(...children) {
    this.children.push(...children);
  }

  async dispatch(type) {
    const listener = this.listeners.get(type);
    if (listener) {
      await listener({ currentTarget: this, target: this, type });
    }
  }
}

class FakeDocument {
  constructor(ids) {
    this.elements = new Map(ids.map((id) => [id, new FakeElement()]));
    this.title = "";
  }

  createElement() {
    return new FakeElement();
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }
}

const ARCHIVE_ELEMENT_IDS = [
  "byte-count",
  "cancel-button",
  "current-item",
  "destination-label",
  "downloads-empty",
  "downloads-list",
  "failure-count",
  "failures-empty",
  "failures-list",
  "fatal-message",
  "fatal-panel",
  "fetched-count",
  "job-progress",
  "job-summary",
  "progress-description",
  "progress-panel",
  "show-downloads-button",
  "status-heading",
  "total-count"
];
let cancellationJobSequence = 0;

async function exerciseCancellationFallback() {
  const listeners = new Set();
  let cancelCalls = 0;
  const downloads = {
    cancel() {
      cancelCalls += 1;
      return Promise.reject(new Error("simulated cancel failure"));
    },
    onChanged: {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      }
    },
    async search() {
      return [{ id: 42, state: "in_progress" }];
    }
  };
  const controller = new AbortController();
  const terminalPromise = ArchivePage.waitForDownloadTerminal(downloads, 42, controller.signal);
  controller.abort();
  const terminal = await Promise.race([
    terminalPromise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("cancel did not settle")), 100))
  ]);
  assert.equal(terminal.state, "interrupted");
  assert.match(terminal.error, /cancelled by user/i);
  assert.equal(cancelCalls, 1);
  assert.equal(listeners.size, 0, "Cancellation must remove the downloads.onChanged listener");
}

async function exerciseRetentionTimeout() {
  const listeners = new Set();
  const downloads = {
    onChanged: {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      }
    },
    async search() {
      return [{ id: 43, state: "in_progress" }];
    }
  };
  const controller = new AbortController();
  const terminal = await ArchivePage.waitForDownloadTerminal(
    downloads,
    43,
    controller.signal,
    { maximumWaitMs: 0, pollIntervalMs: 0 }
  );
  assert.equal(terminal.state, "interrupted");
  assert.match(terminal.error, /stopped waiting/i);
  assert.equal(listeners.size, 0, "A timed-out download wait must remove its listener");
}

async function runCancelledArchive({ items, maximumPartBytes }) {
  const documentObject = new FakeDocument(ARCHIVE_ELEMENT_IDS);
  cancellationJobSequence += 1;
  const jobId = `cancel-job-${cancellationJobSequence}`;
  const storageKey = `archiveJobRequest:${jobId}`;
  const request = {
    createdAt: Date.now(),
    folder: "Website images/cancelled-gallery",
    incognito: false,
    items
  };
  let downloadCount = 0;
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  const originalFetch = global.fetch;
  global.fetch = (_url, options) => {
    resolveFetchStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("cancelled test request");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const changeListeners = new Set();
  const browserObject = {
    downloads: {
      async cancel() {},
      async download() {
        downloadCount += 1;
        return downloadCount;
      },
      onChanged: {
        addListener(listener) {
          changeListeners.add(listener);
        },
        removeListener(listener) {
          changeListeners.delete(listener);
        }
      },
      async search({ id }) {
        return [{ id, state: "complete" }];
      },
      async show() {},
      async showDefaultFolder() {}
    },
    storage: {
      session: {
        async get(key) {
          return key === storageKey ? { [storageKey]: request } : {};
        },
        async remove() {}
      }
    }
  };

  try {
    const pagePromise = ArchivePage.initializeArchivePage({
      browser: browserObject,
      document: documentObject,
      location: { search: `?job=${jobId}` },
      window: { addEventListener() {} },
      maximumPartBytes
    });
    await fetchStarted;
    await documentObject.getElementById("cancel-button").dispatch("click");
    await pagePromise;
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(documentObject.getElementById("status-heading").textContent, "Archive cancelled");
  assert.equal(changeListeners.size, 0);
  return { documentObject, downloadCount };
}

async function exerciseCancellationCopyTracksSavedParts() {
  const beforeFirstSave = await runCancelledArchive({
    items: [
      { url: "data:image/png;base64,AA==" },
      { url: "https://images.example/pending-before-first-save.png" }
    ],
    maximumPartBytes: 4096
  });
  assert.equal(beforeFirstSave.downloadCount, 0);
  assert.equal(
    beforeFirstSave.documentObject.getElementById("progress-description").textContent,
    "No unfinished archive was saved.",
    "Fetched-but-buffered images must not be described as a completed archive part"
  );

  const firstEntry = { name: "image-0001.png", size: 1 };
  const secondEntry = { name: "image-0002.png", size: 1 };
  const oneEntryLimit = Math.max(
    ArchivePage.estimateStoredZipSize([firstEntry]),
    ArchivePage.estimateStoredZipSize([secondEntry])
  );
  assert.ok(
    ArchivePage.estimateStoredZipSize([firstEntry, secondEntry]) > oneEntryLimit,
    "The cancellation fixture must force multipart output"
  );
  const afterFirstSave = await runCancelledArchive({
    items: [
      { url: "data:image/png;base64,AA==" },
      { url: "data:image/png;base64,AA==" },
      { url: "https://images.example/pending-after-first-save.png" }
    ],
    maximumPartBytes: oneEntryLimit
  });
  assert.equal(afterFirstSave.downloadCount, 1);
  assert.equal(
    afterFirstSave.documentObject.getElementById("progress-description").textContent,
    "Previously completed archive parts remain in Downloads; the unfinished part was discarded."
  );
}

async function exerciseFiveHundredItemPage() {
  archiveObjectUrls.length = 0;
  revokedArchiveObjectUrls.length = 0;
  const documentObject = new FakeDocument(ARCHIVE_ELEMENT_IDS);
  const jobId = "runtime-job-500";
  const storageKey = `archiveJobRequest:${jobId}`;
  const request = {
    createdAt: Date.now(),
    folder: "Website images/runtime-gallery",
    incognito: false,
    items: Array.from({ length: 500 }, () => ({
      url: "data:image/png;base64,AA=="
    }))
  };
  const removedKeys = [];
  const downloadCalls = [];
  const changeListeners = new Set();
  const browserObject = {
    downloads: {
      async download(details) {
        downloadCalls.push(details);
        return downloadCalls.length;
      },
      onChanged: {
        addListener(listener) {
          changeListeners.add(listener);
        },
        removeListener(listener) {
          changeListeners.delete(listener);
        }
      },
      async search({ id }) {
        return [{ id, state: "complete" }];
      },
      show() {
        return Promise.resolve();
      },
      showDefaultFolder() {}
    },
    storage: {
      session: {
        async get(key) {
          return key === storageKey ? { [storageKey]: request } : {};
        },
        async remove(key) {
          removedKeys.push(key);
        }
      }
    }
  };

  await ArchivePage.initializeArchivePage({
    browser: browserObject,
    document: documentObject,
    location: { search: `?job=${jobId}` },
    window: { addEventListener() {} },
    maximumPartBytes: 4096
  });

  assert.equal(documentObject.getElementById("fetched-count").textContent, "500");
  assert.equal(documentObject.getElementById("failure-count").textContent, "0");
  assert.equal(documentObject.getElementById("status-heading").textContent, "Archive complete");
  assert.equal(documentObject.getElementById("job-progress").value, 500);
  assert.ok(downloadCalls.length > 10, "500 images must exercise sequential multipart creation");
  downloadCalls.forEach((download, index) => {
    assert.match(
      download.filename,
      new RegExp(`runtime-gallery/runtime-gallery-part-${String(index + 1).padStart(3, "0")}\\.zip$`)
    );
    assert.match(download.url, /^blob:/);
  });
  assert.equal(
    documentObject.getElementById("downloads-list").children.length,
    downloadCalls.length
  );
  assert.equal(archiveObjectUrls.length, downloadCalls.length);
  assert.ok(
    archiveObjectUrls.every(({ blob }) => blob.size <= 4096),
    "Every runtime-generated ZIP part must respect the configured cap"
  );
  assert.deepEqual(
    revokedArchiveObjectUrls,
    archiveObjectUrls.map(({ objectUrl }) => objectUrl),
    "Every completed part must release its Blob URL before the next part remains resident"
  );
  assert.ok(removedKeys.includes(storageKey), "The one-time session request must be removed");
  assert.equal(changeListeners.size, 0, "Completed downloads must release their listeners");
}

Promise.resolve()
  .then(exerciseCancellationFallback)
  .then(exerciseRetentionTimeout)
  .then(exerciseCancellationCopyTracksSavedParts)
  .then(exerciseFiveHundredItemPage)
  .then(() => {
    console.log("All Archive Progress page checks passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
