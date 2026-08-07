"use strict";

const assert = require("assert").strict;
const { createDimensionProbeScheduler } = require("../extension/popup/popup.js");

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
