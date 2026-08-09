"use strict";

const assert = require("assert").strict;
const Templates = require("../extension/shared/templates.js");
const {
  accumulateLiveImages,
  collectLiveGalleryFingerprint,
  createDimensionProbeScheduler,
  downloadBatchNotice,
  hostPermissionPatternsForImages,
  launchOptionsFromUrl,
  canRetainSameInstagramRoute,
  matchesInstagramCollectionFilter,
  mergeInstagramCollections,
  reconcileScanSelection,
  renderFilenameBatch,
  sourceTabIdFromUrl
} = require("../extension/popup/popup.js");

assert.deepEqual(downloadBatchNotice({ queued: 3, failed: 0, total: 3 }), {
  type: "success",
  message: "Added 3 downloads to the queue. Open Downloads to monitor progress."
});
assert.deepEqual(downloadBatchNotice({
  queued: 2,
  failed: 1,
  total: 3,
  errors: [{ error: "Queue capacity reached." }]
}), {
  type: "error",
  message: "Added 2 of 3 downloads to the queue. 1 could not be queued. First problem: Queue capacity reached."
});
assert.equal(downloadBatchNotice({ started: 1 }), null);

const filenameRecords = [
  { url: "https://images.test/photo.jpg", width: 0, height: 0 },
  { url: "https://images.test/photo.jpg?variant=second", width: 0, height: 0 }
];
const batchDate = new Date(2026, 7, 8, 12, 0, 0);
const renderWithTemplate = (template, records) => renderFilenameBatch(
  records,
  (image, index, usedNames) => Templates.render(template, {
    url: image.url,
    filename: "photo.jpg",
    index: index + 1,
    width: image.width,
    height: image.height,
    date: batchDate
  }, { usedNames })
);
assert.deepEqual(
  renderWithTemplate("{filename}", filenameRecords).map((item) => item.filename),
  ["photo.jpg", "photo-2.jpg"],
  "Filename previews and payloads must share one collision set"
);
assert.deepEqual(
  renderWithTemplate(Templates.DEFAULT_TEMPLATE, filenameRecords).map((item) => item.filename),
  ["0001-photo.jpg", "0002-photo.jpg"],
  "Default filenames must preserve selected input and site-discovery order before concurrent work starts"
);
assert.equal(
  renderWithTemplate("{index}-{filename}", [filenameRecords[1]])[0].filename,
  "0001-photo.jpg",
  "A selected subset must be indexed by batch position rather than discovery position"
);
filenameRecords[0].width = 1920;
filenameRecords[0].height = 1080;
assert.equal(
  renderWithTemplate("{width}x{height}-{filename}", [filenameRecords[0]])[0].filename,
  "1920x1080-photo.jpg",
  "Measured dimensions must flow through the shared batch renderer"
);

assert.equal(
  sourceTabIdFromUrl("moz-extension://fixture/popup/popup.html?sourceTabId=73&launch=abc"),
  73
);
assert.equal(sourceTabIdFromUrl("moz-extension://fixture/popup/popup.html?sourceTabId=-1"), null);
assert.equal(sourceTabIdFromUrl("moz-extension://fixture/popup/popup.html?sourceTabId=1.5"), null);
assert.equal(sourceTabIdFromUrl("not a URL"), null);
assert.deepEqual(
  launchOptionsFromUrl("moz-extension://fixture/popup/popup.html?sourceTabId=73"),
  { sidebar: false }
);
assert.deepEqual(
  launchOptionsFromUrl("moz-extension://fixture/popup/popup.html?sidebar=1"),
  { sidebar: true }
);
assert.deepEqual(launchOptionsFromUrl("not a URL"), { sidebar: false });

assert.equal(typeof matchesInstagramCollectionFilter, "function");
assert.equal(typeof mergeInstagramCollections, "function");
const postCollection = { type: "post", id: "POST1", title: "Post one", owner: "Alice" };
const storyCollection = { type: "story", id: "STORY1", title: "Current story", owner: "ALICE" };
const highlightCollection = { type: "highlight", id: "HIGHLIGHT1", title: "Travel", owner: "alice" };
assert.deepEqual(
  mergeInstagramCollections(
    [postCollection, highlightCollection],
    [
      { ...highlightCollection, title: "Duplicate title" },
      storyCollection,
      { type: "unknown", id: "ignored" }
    ]
  ),
  [
    { ...postCollection, owner: "alice" },
    highlightCollection,
    { ...storyCollection, owner: "alice" }
  ],
  "Instagram collection metadata must merge by type/id in stable order"
);
const instagramImage = {
  instagramCollections: [postCollection, storyCollection, highlightCollection]
};
assert.equal(matchesInstagramCollectionFilter(instagramImage, "all"), true);
assert.equal(matchesInstagramCollectionFilter(instagramImage, "posts"), true);
assert.equal(matchesInstagramCollectionFilter(instagramImage, "story"), true);
assert.equal(matchesInstagramCollectionFilter(instagramImage, "highlights"), true);
assert.equal(matchesInstagramCollectionFilter(instagramImage, "highlight:HIGHLIGHT1"), true);
assert.equal(matchesInstagramCollectionFilter(instagramImage, "highlight:OTHER"), false);
assert.equal(matchesInstagramCollectionFilter(instagramImage, "unknown"), false);
assert.equal(matchesInstagramCollectionFilter(instagramImage, "highlight:<script>"), false);
assert.equal(matchesInstagramCollectionFilter({ instagramCollections: [postCollection] }, "story"), false);

assert.equal(
  canRetainSameInstagramRoute("instagram:post:POST1", "instagram:post:POST1", false),
  true,
  "Changing img_index within one exact post must keep automatic updates running"
);
assert.equal(
  canRetainSameInstagramRoute("instagram:profile:alice", "instagram:post:POST1", false),
  false,
  "Profile-to-post navigation must clear the old collection scope"
);
assert.equal(
  canRetainSameInstagramRoute("instagram:post:POST1", "instagram:post:POST1", true),
  false,
  "A full page load must not retain stale exact-route results"
);
assert.equal(
  canRetainSameInstagramRoute("https://example.test", "https://example.test", false),
  false,
  "Generic same-origin navigation must not reuse stale page results"
);

assert.deepEqual(
  hostPermissionPatternsForImages([
    { url: "https://cdn.example.test/photo.jpg?size=full" },
    { url: "https://cdn.example.test/second.webp" },
    { url: "http://images.example.test:8080/image.png" },
    { url: "data:image/png;base64,AA==" },
    { url: "not a URL" }
  ]),
  ["http://images.example.test/*", "https://cdn.example.test/*"],
  "Archive permission prompts must be deduplicated and limited to selected HTTP(S) origins"
);
assert.deepEqual(hostPermissionPatternsForImages([]), []);

{
  const attributes = { src: "https://images.test/first.jpg", class: "gallery-image" };
  const node = {
    localName: "img",
    currentSrc: attributes.src,
    getAttribute(name) {
      return attributes[name] || "";
    }
  };
  const previousDocument = global.document;
  global.document = {
    URL: "https://gallery.test/page",
    images: { length: 1 },
    documentElement: { scrollHeight: 1800, scrollWidth: 1200 },
    querySelectorAll() {
      return [node];
    }
  };
  try {
    const first = collectLiveGalleryFingerprint({ maxElements: 2500 });
    const repeated = collectLiveGalleryFingerprint({ maxElements: 2500 });
    assert.equal(first.fingerprint, repeated.fingerprint, "An unchanged gallery fingerprint must be stable");
    assert.equal(first.pageUrl, "https://gallery.test/page");
    attributes.src = "https://images.test/second.jpg";
    node.currentSrc = attributes.src;
    const changed = collectLiveGalleryFingerprint({ maxElements: 2500 });
    assert.notEqual(changed.fingerprint, first.fingerprint, "A virtualized image src change must be detected");
  } finally {
    global.document = previousDocument;
  }
}

{
  const first = { url: "https://images.test/first.jpg", width: 800, height: 600 };
  const unchecked = { url: "https://images.test/unchecked.jpg", width: 800, height: 600 };
  const replacement = { url: first.url, width: 2400, height: 1600 };
  const added = { url: "https://images.test/added.jpg", width: 1200, height: 800 };
  const rejected = { url: "https://images.test/logo.png", width: 80, height: 40 };
  const accumulated = accumulateLiveImages(
    [first, unchecked],
    [replacement, added, rejected],
    { maxImages: 10, maxPayloadLength: 10000 }
  );
  assert.equal(accumulated.trimmed, false);
  assert.deepEqual(accumulated.images.map((image) => image.url), [
    first.url,
    unchecked.url,
    added.url,
    rejected.url
  ]);
  assert.equal(accumulated.images[0].width, 2400, "The newest metadata must replace an older live record");

  const selected = reconcileScanSelection(
    accumulated.images,
    [first, unchecked],
    new Set([first.url]),
    true,
    (image) => image.url !== rejected.url
  );
  assert.deepEqual(
    [...selected],
    [first.url, added.url],
    "Automatic updates must preserve known checked/unchecked state and select only eligible new images"
  );
  const freshSelection = reconcileScanSelection(
    accumulated.images,
    [first, unchecked],
    new Set(),
    false,
    (image) => image.url !== rejected.url
  );
  assert.deepEqual([...freshSelection], [first.url, unchecked.url, added.url]);

  const bounded = accumulateLiveImages([first], [added], {
    maxImages: 1,
    maxPayloadLength: 10000
  });
  assert.equal(bounded.trimmed, true);
  assert.deepEqual(bounded.images.map((image) => image.url), [first.url]);
}

function createHarness(options = {}) {
  const probes = [];
  const timers = new Map();
  let nextTimerId = 1;
  let paused = Boolean(options.paused);
  let createFailures = Number(options.createFailures) || 0;
  let sourceFailures = Number(options.sourceFailures) || 0;

  function createImage() {
    if (createFailures > 0) {
      createFailures -= 1;
      throw new Error("synthetic image-constructor failure");
    }
    let source = "";
    const probe = {
      naturalWidth: 0,
      naturalHeight: 0,
      onload: null,
      onerror: null
    };
    Object.defineProperty(probe, "src", {
      get() {
        return source;
      },
      set(value) {
        if (sourceFailures > 0) {
          sourceFailures -= 1;
          throw new Error("synthetic image-source failure");
        }
        source = value;
      }
    });
    probes.push(probe);
    return probe;
  }

  const scheduler = createDimensionProbeScheduler({
    maxConcurrency: options.maxConcurrency || 3,
    timeoutMs: 15000,
    createImage,
    setTimer(callback) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    isPaused: () => paused,
    canStart: options.canStart || (() => true)
  });

  return {
    scheduler,
    probes,
    timers,
    setPaused(value) {
      paused = Boolean(value);
    },
    complete(probe, width = 1600, height = 900) {
      probe.naturalWidth = width;
      probe.naturalHeight = height;
      assert.equal(typeof probe.onload, "function");
      probe.onload();
    },
    fail(probe) {
      assert.equal(typeof probe.onerror, "function");
      probe.onerror();
    }
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

(async () => {
  // Requests are deduplicated by full URL and never exceed the configured
  // concurrency, even while completion synchronously pumps the next item.
  {
    const harness = createHarness({ maxConcurrency: 3 });
    const urls = Array.from({ length: 5 }, (_, index) => `https://images.test/${index}.jpg`);
    const promises = urls.map((url) => harness.scheduler.request(url, { generation: 1 }));
    assert.equal(harness.probes.length, 3);
    assert.equal(harness.scheduler.activeCount, 3);
    assert.equal(harness.scheduler.queuedCount, 2);

    const repeated = harness.scheduler.request(urls[0], { generation: 99 });
    assert.strictEqual(repeated, promises[0]);
    assert.equal(harness.probes.length, 3);

    harness.complete(harness.probes[0], 2400, 1600);
    assert.deepEqual(await promises[0], { width: 2400, height: 1600, cancelled: false });
    assert.equal(harness.probes.length, 4);
    assert.equal(harness.scheduler.activeCount, 3);

    for (let index = 1; index < harness.probes.length; index += 1) {
      if (harness.probes[index].onload) {
        harness.complete(harness.probes[index]);
      }
    }
    await Promise.all(promises);
    assert.equal(harness.probes.length, 5);
    assert.equal(harness.scheduler.activeCount, 0);
    assert.equal(harness.scheduler.queuedCount, 0);
  }

  // Busy state pauses both new work and queue pumping. Finishing an active
  // request while paused must not start the next full-image load.
  {
    const harness = createHarness({ maxConcurrency: 1 });
    const first = harness.scheduler.request("https://images.test/first.jpg", { generation: 1 });
    const second = harness.scheduler.request("https://images.test/second.jpg", { generation: 1 });
    assert.equal(harness.probes.length, 1);
    harness.setPaused(true);
    harness.complete(harness.probes[0]);
    await first;
    assert.equal(harness.probes.length, 1);
    assert.equal(harness.scheduler.queuedCount, 1);

    harness.setPaused(false);
    harness.scheduler.pump();
    assert.equal(harness.probes.length, 2);
    harness.complete(harness.probes[1]);
    await second;
  }

  // A generation/visibility check can reject stale work before it creates an
  // Image, and canceled work is removable so a later visible render can retry.
  {
    let currentGeneration = 2;
    const harness = createHarness({
      canStart: (_url, context) => context.generation === currentGeneration
    });
    const stale = await harness.scheduler.request("https://images.test/stale.jpg", { generation: 1 });
    assert.equal(stale.cancelled, true);
    assert.equal(harness.probes.length, 0);
    assert.equal(harness.scheduler.getStatus("https://images.test/stale.jpg"), "none");

    const current = harness.scheduler.request("https://images.test/stale.jpg", { generation: 2 });
    assert.equal(harness.probes.length, 1);
    harness.complete(harness.probes[0]);
    assert.equal((await current).cancelled, false);
    currentGeneration = 3;
  }

  // Rerender cancellation removes queued (not active) tasks and resolves their
  // callers without converting them into a permanent failed cache entry.
  {
    const harness = createHarness({ maxConcurrency: 1 });
    const active = harness.scheduler.request("https://images.test/active.jpg", { generation: 1 });
    const queued = harness.scheduler.request("https://images.test/queued.jpg", { generation: 1 });
    const cancelled = harness.scheduler.cancelQueued(
      (_url, context) => context.generation === 1
    );
    assert.deepEqual(cancelled, ["https://images.test/queued.jpg"]);
    assert.equal((await queued).cancelled, true);
    assert.equal(harness.scheduler.getStatus("https://images.test/queued.jpg"), "none");
    assert.equal(harness.probes.length, 1);
    harness.complete(harness.probes[0]);
    await active;
    assert.equal(harness.probes.length, 1);
  }

  // Synchronous constructor or src-assignment errors settle as ordinary probe
  // failures, free their slots, and allow later work to continue.
  {
    const constructorFailure = createHarness({ createFailures: 1, maxConcurrency: 1 });
    const failed = await constructorFailure.scheduler.request(
      "https://images.test/create-failure.jpg",
      { generation: 1 }
    );
    assert.deepEqual(failed, { width: 0, height: 0, cancelled: false });
    assert.equal(constructorFailure.scheduler.activeCount, 0);

    const recovered = constructorFailure.scheduler.request(
      "https://images.test/after-create-failure.jpg",
      { generation: 1 }
    );
    assert.equal(constructorFailure.probes.length, 1);
    constructorFailure.complete(constructorFailure.probes[0]);
    await recovered;

    const sourceFailure = createHarness({ sourceFailures: 1, maxConcurrency: 1 });
    const sourceResult = await sourceFailure.scheduler.request(
      "https://images.test/src-failure.jpg",
      { generation: 1 }
    );
    assert.deepEqual(sourceResult, { width: 0, height: 0, cancelled: false });
    assert.equal(sourceFailure.scheduler.activeCount, 0);
  }

  // Timeout settlement aborts the probe, clears the timer, and cannot settle a
  // second time if an obsolete load callback was retained by a caller.
  {
    const harness = createHarness({ maxConcurrency: 1 });
    const promise = harness.scheduler.request("https://images.test/timeout.jpg", { generation: 1 });
    const probe = harness.probes[0];
    const obsoleteLoad = probe.onload;
    assert.equal(harness.timers.size, 1);
    const timeout = Array.from(harness.timers.values())[0];
    timeout();
    assert.deepEqual(await promise, { width: 0, height: 0, cancelled: false });
    assert.equal(harness.scheduler.activeCount, 0);
    assert.equal(harness.timers.size, 0);
    obsoleteLoad();
    await flushMicrotasks();
    assert.equal(harness.scheduler.activeCount, 0);
  }

  console.log("All dimension-probe scheduler checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
