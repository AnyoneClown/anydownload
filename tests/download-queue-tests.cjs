"use strict";

const assert = require("assert").strict;
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Queue = require("../extension/shared/download-queue.js");

const source = fs.readFileSync(
  path.resolve(__dirname, "../extension/shared/download-queue.js"),
  "utf8"
);
const browserContext = { URL };
vm.createContext(browserContext);
vm.runInContext(source, browserContext);
assert.equal(
  typeof browserContext.ImageDownloaderDownloadQueue.enqueueBatch,
  "function",
  "The browser build must expose ImageDownloaderDownloadQueue"
);
assert.doesNotMatch(source, /\bbrowser\s*\./, "The queue model must not call WebExtension APIs");

const BASE_TIME = Date.UTC(2026, 7, 7, 12, 0, 0);
const BASE_DAY = Queue.dayKey(BASE_TIME);
const PREVIOUS_DAY = Queue.dayKey(BASE_TIME - (24 * 60 * 60 * 1000));
const deterministicIds = (kind, index) => `${kind}-${index}`;

function enqueue(state, count, options) {
  return Queue.enqueueBatch(
    state,
    Array.from({ length: count }, (_value, index) => ({
      url: `https://images.example/photo-${index}.jpg#ignored-fragment`,
      filename: `photo-${index}.jpg`
    })),
    { now: BASE_TIME, idFactory: deterministicIds, folder: "Website images", ...options }
  );
}

assert.equal(Queue.SCHEMA_VERSION, 1);
assert.equal(Queue.MAX_BATCH_SIZE, 1500);
assert.equal(Queue.MAX_STORED_TASKS, 1500);
assert.ok(Object.isFrozen(Queue.TASK_STATUSES));
assert.deepEqual(Queue.TASK_STATUSES, [
  "queued",
  "starting",
  "in_progress",
  "paused",
  "complete",
  "interrupted",
  "cancelled"
]);

const localDayCheck = execFileSync(process.execPath, [
  "-e",
  [
    `const Queue = require(${JSON.stringify(path.resolve(__dirname, "../extension/shared/download-queue.js"))});`,
    "const localMidnight = new Date(2026, 7, 8, 0, 30, 0, 0);",
    "process.stdout.write(Queue.dayKey(localMidnight.getTime()));"
  ].join("\n")
], {
  encoding: "utf8",
  env: { ...process.env, TZ: "Pacific/Kiritimati" }
});
assert.equal(
  localDayCheck,
  "2026-08-08",
  "Daily counters must use the user's local calendar day instead of UTC"
);

const empty = Queue.emptyState(BASE_TIME);
assert.deepEqual(empty, {
  schemaVersion: 1,
  jobs: [],
  history: [],
  stats: {
    lifetime: {
      enqueued: 0,
      completed: 0,
      interrupted: 0,
      cancelled: 0,
      bytesDownloaded: 0
    },
    today: {
      date: BASE_DAY,
      enqueued: 0,
      completed: 0,
      interrupted: 0,
      cancelled: 0,
      bytesDownloaded: 0
    }
  }
});

const firstBatch = Queue.enqueueBatch(empty, [
  {
    url: "https://images.example/one.jpg#preview",
    filename: "one.jpg",
    siteKey: "https://gallery.example/page",
    mediaFingerprint: "0123456789abcdef",
    mediaType: "image"
  },
  { url: "javascript:alert(1)", filename: "bad.jpg" },
  { url: "data:image/png;base64,AA==", filename: "embedded.png" }
], {
  now: BASE_TIME,
  idFactory: deterministicIds,
  label: "A".repeat(300),
  folder: "F".repeat(300),
  source: "S".repeat(1000),
  saveAs: true
});
assert.equal(firstBatch.accepted, 2);
assert.deepEqual(firstBatch.acceptedIndexes, [0, 2]);
assert.equal(firstBatch.rejected.length, 1);
assert.equal(firstBatch.rejected[0].index, 1);
assert.equal(empty.jobs.length, 0, "Transitions must not mutate the input state");
assert.equal(firstBatch.state.jobs[0].tasks[0].url, "https://images.example/one.jpg");
assert.equal(firstBatch.state.jobs[0].tasks[0].siteKey, "https://gallery.example");
assert.equal(firstBatch.state.jobs[0].tasks[0].mediaFingerprint, "0123456789abcdef");
assert.equal(firstBatch.state.jobs[0].tasks[0].ledgerRecorded, false);
assert.equal(firstBatch.state.jobs[0].label.length, 200);
assert.equal(firstBatch.state.jobs[0].folder.length, 240);
assert.equal(firstBatch.state.jobs[0].source.length, 500);
assert.equal(firstBatch.state.jobs[0].saveAs, true);
assert.equal(firstBatch.state.stats.lifetime.enqueued, 2);
assert.equal(firstBatch.state.stats.today.enqueued, 2);

const embeddedVideoBatch = Queue.enqueueBatch(Queue.emptyState(BASE_TIME), [
  { url: "data:video/mp4;base64,AQID", filename: "embedded-video.mp4" },
  { url: "data:application/mp4;base64,AQID", filename: "not-media.mp4" }
], {
  now: BASE_TIME,
  idFactory: deterministicIds,
  folder: "Website media"
});
assert.equal(embeddedVideoBatch.accepted, 1);
assert.equal(embeddedVideoBatch.rejected.length, 1);
assert.equal(
  embeddedVideoBatch.state.jobs[0].tasks[0].url,
  "data:video/mp4;base64,AQID"
);
assert.equal(embeddedVideoBatch.state.jobs[0].tasks[0].filename, "embedded-video.mp4");

const invalidBatch = Queue.enqueueBatch(firstBatch.state, "not-an-array", { now: BASE_TIME });
assert.equal(invalidBatch.accepted, 0);
assert.match(invalidBatch.rejected[0].error, /array/i);
assert.equal(invalidBatch.state.jobs.length, 1);

let working = enqueue(Queue.emptyState(BASE_TIME), 3).state;
const originalWorking = working;
let claim = Queue.claimNextTasks(working, { concurrency: 2, now: BASE_TIME + 1 });
working = claim.state;
assert.deepEqual(claim.tasks.map((task) => task.filename), ["photo-0.jpg", "photo-1.jpg"]);
assert.deepEqual(claim.tasks.map((task) => task.saveAs), [false, false]);
assert.deepEqual(working.jobs[0].tasks.map((task) => task.status), [
  "starting",
  "starting",
  "queued"
]);
assert.deepEqual(originalWorking.jobs[0].tasks.map((task) => task.status), [
  "queued",
  "queued",
  "queued"
]);
assert.equal(Queue.claimNextTasks(working, { concurrency: 2, now: BASE_TIME + 2 }).tasks.length, 0);

working = Queue.bindDownload(working, claim.tasks[0].id, 101, { now: BASE_TIME + 3 });
working = Queue.bindDownload(working, claim.tasks[1].id, 102, { now: BASE_TIME + 3 });
assert.equal(working.jobs[0].status, "in_progress");
working = Queue.applyDownloadChange(working, 101, {
  bytesReceived: { current: 40 },
  totalBytes: { current: 100 },
  paused: { current: false }
}, { now: BASE_TIME + 4 });
assert.equal(working.jobs[0].tasks[0].bytesReceived, 40);
assert.equal(working.jobs[0].tasks[0].totalBytes, 100);

working = Queue.setTaskPaused(working, claim.tasks[1].id, true, { now: BASE_TIME + 5 });
assert.equal(working.jobs[0].tasks[1].status, "paused");
working = Queue.applyDownloadChange(working, 102, {
  bytesReceived: { current: 10 }
}, { now: BASE_TIME + 5 });
assert.equal(
  working.jobs[0].tasks[1].status,
  "paused",
  "An unrelated partial delta must not silently unpause a download"
);
working = Queue.setTaskPaused(working, claim.tasks[1].id, false, { now: BASE_TIME + 6 });
assert.equal(working.jobs[0].tasks[1].status, "in_progress");

working = Queue.applyDownloadSnapshot(working, {
  id: 101,
  state: "complete",
  bytesReceived: 100,
  totalBytes: 100
}, { now: BASE_TIME + 7 });
assert.equal(working.state, undefined, "A state transition returns the state directly");
assert.equal(working.jobs[0].tasks[0].status, "complete");
assert.equal(working.stats.lifetime.completed, 1);
assert.equal(working.stats.lifetime.bytesDownloaded, 100);

working = Queue.applyDownloadSnapshot(working, {
  id: 101,
  state: "complete",
  bytesReceived: 100,
  totalBytes: 100
}, { now: BASE_TIME + 8 });
assert.equal(working.stats.lifetime.completed, 1, "Replayed completion must be counted once");
assert.equal(working.stats.lifetime.bytesDownloaded, 100, "Replayed bytes must be counted once");

let delayedMetadata = enqueue(Queue.emptyState(BASE_TIME), 1).state;
let delayedClaim = Queue.claimNextTasks(delayedMetadata, {
  concurrency: 1,
  now: BASE_TIME + 1
});
delayedMetadata = Queue.bindDownload(
  delayedClaim.state,
  delayedClaim.tasks[0].id,
  150,
  { now: BASE_TIME + 2 }
);
delayedMetadata = Queue.applyDownloadChange(delayedMetadata, 150, {
  state: { current: "complete" }
}, { now: BASE_TIME + 3 });
assert.equal(delayedMetadata.jobs[0].tasks[0].status, "complete");
assert.equal(delayedMetadata.jobs[0].tasks[0].needsReconciliation, true);
assert.equal(delayedMetadata.stats.lifetime.completed, 1);
assert.equal(delayedMetadata.stats.lifetime.bytesDownloaded, 0);
assert.equal(delayedMetadata.history[0].bytesDownloaded, 0);
assert.equal(
  Queue.clearCompleted(delayedMetadata, { now: BASE_TIME + 4 }).removed,
  0,
  "A completed row awaiting metadata reconciliation must not be discarded"
);
delayedMetadata = Queue.hydrate(delayedMetadata, { now: BASE_TIME + 4 });
assert.equal(
  delayedMetadata.jobs[0].tasks[0].needsReconciliation,
  true,
  "The reconciliation marker must survive a background restart"
);
delayedMetadata = Queue.applyDownloadSnapshot(delayedMetadata, {
  id: 150,
  state: "in_progress",
  bytesReceived: 2048,
  totalBytes: 4096
}, { now: BASE_TIME + 4 });
assert.equal(
  delayedMetadata.jobs[0].tasks[0].needsReconciliation,
  true,
  "A stale nonterminal snapshot must not override a terminal event"
);
assert.equal(delayedMetadata.jobs[0].tasks[0].bytesReceived, 0);
delayedMetadata = Queue.applyDownloadSnapshot(delayedMetadata, {
  id: 150,
  state: "complete",
  bytesReceived: 4096,
  totalBytes: 4096,
  filename: "final-photo.jpg"
}, { now: BASE_TIME + 5 });
assert.equal(delayedMetadata.jobs[0].tasks[0].needsReconciliation, false);
assert.equal(delayedMetadata.jobs[0].tasks[0].filename, "final-photo.jpg");
assert.equal(delayedMetadata.stats.lifetime.completed, 1);
assert.equal(delayedMetadata.stats.lifetime.bytesDownloaded, 4096);
assert.equal(delayedMetadata.stats.today.bytesDownloaded, 4096);
assert.equal(delayedMetadata.history[0].bytesDownloaded, 4096);
delayedMetadata = Queue.applyDownloadSnapshot(delayedMetadata, {
  id: 150,
  state: "complete",
  bytesReceived: 4096,
  totalBytes: 4096,
  filename: "final-photo.jpg"
}, { now: BASE_TIME + 6 });
assert.equal(delayedMetadata.stats.lifetime.completed, 1);
assert.equal(delayedMetadata.stats.lifetime.bytesDownloaded, 4096);

let nextDayMetadata = enqueue(Queue.emptyState(BASE_TIME), 1).state;
const nextDayClaim = Queue.claimNextTasks(nextDayMetadata, {
  concurrency: 1,
  now: BASE_TIME + 1
});
nextDayMetadata = Queue.bindDownload(
  nextDayClaim.state,
  nextDayClaim.tasks[0].id,
  151,
  { now: BASE_TIME + 2 }
);
nextDayMetadata = Queue.applyDownloadChange(nextDayMetadata, 151, {
  state: { current: "complete" },
  bytesReceived: { current: 1024 },
  totalBytes: { current: 1024 }
}, { now: BASE_TIME + 3 });
nextDayMetadata = Queue.applyDownloadSnapshot(nextDayMetadata, {
  id: 151,
  state: "complete",
  bytesReceived: 4096,
  totalBytes: 4096
}, { now: BASE_TIME + 24 * 60 * 60 * 1000 });
assert.equal(nextDayMetadata.stats.lifetime.completed, 1);
assert.equal(nextDayMetadata.stats.lifetime.bytesDownloaded, 4096);
assert.equal(nextDayMetadata.stats.today.completed, 0);
assert.equal(
  nextDayMetadata.stats.today.bytesDownloaded,
  0,
  "Late reconciliation must not attribute yesterday's bytes to today"
);

let fileSizeFallback = enqueue(Queue.emptyState(BASE_TIME), 1).state;
const fileSizeClaim = Queue.claimNextTasks(fileSizeFallback, {
  concurrency: 1,
  now: BASE_TIME + 1
});
fileSizeFallback = Queue.bindDownload(
  fileSizeClaim.state,
  fileSizeClaim.tasks[0].id,
  152,
  { now: BASE_TIME + 2 }
);
fileSizeFallback = Queue.applyDownloadSnapshot(fileSizeFallback, {
  id: 152,
  state: "complete",
  bytesReceived: 0,
  totalBytes: -1,
  fileSize: 1234
}, { now: BASE_TIME + 3 });
assert.equal(fileSizeFallback.jobs[0].tasks[0].totalBytes, 1234);
assert.equal(fileSizeFallback.jobs[0].tasks[0].bytesReceived, 1234);
assert.equal(fileSizeFallback.stats.lifetime.bytesDownloaded, 1234);

const completionCreatedAt = new Date(2026, 7, 7, 9, 0, 0, 0).getTime();
const nativeCompletionAt = new Date(2026, 7, 7, 10, 30, 0, 0).getTime();
const completionObservedAt = new Date(2026, 7, 8, 12, 0, 0, 0).getTime();
let missedCompletion = enqueue(Queue.emptyState(completionCreatedAt), 1, {
  now: completionCreatedAt
}).state;
const missedCompletionClaim = Queue.claimNextTasks(missedCompletion, {
  concurrency: 1,
  now: completionCreatedAt + 1
});
missedCompletion = Queue.bindDownload(
  missedCompletionClaim.state,
  missedCompletionClaim.tasks[0].id,
  153,
  { now: completionCreatedAt + 2 }
);
missedCompletion = Queue.applyDownloadSnapshot(missedCompletion, {
  id: 153,
  state: "complete",
  bytesReceived: 2048,
  totalBytes: 2048,
  endTime: new Date(nativeCompletionAt).toISOString()
}, { now: completionObservedAt });
assert.equal(missedCompletion.jobs[0].tasks[0].completedAt, nativeCompletionAt);
assert.equal(missedCompletion.jobs[0].finishedAt, nativeCompletionAt);
assert.equal(missedCompletion.history[0].finishedAt, nativeCompletionAt);
assert.equal(missedCompletion.stats.lifetime.completed, 1);
assert.equal(missedCompletion.stats.lifetime.bytesDownloaded, 2048);
assert.equal(
  missedCompletion.stats.today.completed,
  0,
  "A completion discovered later must not be attributed to the observation day"
);
assert.equal(missedCompletion.stats.today.bytesDownloaded, 0);

let correctedCompletion = enqueue(Queue.emptyState(completionCreatedAt), 1, {
  now: completionCreatedAt
}).state;
const correctedClaim = Queue.claimNextTasks(correctedCompletion, {
  concurrency: 1,
  now: completionCreatedAt + 1
});
correctedCompletion = Queue.bindDownload(
  correctedClaim.state,
  correctedClaim.tasks[0].id,
  154,
  { now: completionCreatedAt + 2 }
);
correctedCompletion = Queue.applyDownloadChange(correctedCompletion, 154, {
  state: { current: "complete" },
  bytesReceived: { current: 512 },
  totalBytes: { current: 512 }
}, { now: completionObservedAt });
assert.equal(correctedCompletion.stats.today.completed, 1);
correctedCompletion = Queue.applyDownloadSnapshot(correctedCompletion, {
  id: 154,
  state: "complete",
  bytesReceived: 1024,
  totalBytes: 1024,
  endTime: new Date(nativeCompletionAt).toISOString()
}, { now: completionObservedAt + 1 });
assert.equal(correctedCompletion.jobs[0].tasks[0].completedAt, nativeCompletionAt);
assert.equal(correctedCompletion.stats.lifetime.completed, 1);
assert.equal(correctedCompletion.stats.lifetime.bytesDownloaded, 1024);
assert.equal(
  correctedCompletion.stats.today.completed,
  0,
  "Late native endTime metadata must move a previously recorded outcome off today"
);
assert.equal(correctedCompletion.stats.today.bytesDownloaded, 0);

let boundedCompletion = enqueue(Queue.emptyState(completionCreatedAt), 1, {
  now: completionCreatedAt
}).state;
const boundedClaim = Queue.claimNextTasks(boundedCompletion, {
  concurrency: 1,
  now: completionCreatedAt + 1
});
boundedCompletion = Queue.bindDownload(
  boundedClaim.state,
  boundedClaim.tasks[0].id,
  155,
  { now: completionCreatedAt + 2 }
);
boundedCompletion = Queue.applyDownloadSnapshot(boundedCompletion, {
  id: 155,
  state: "interrupted",
  endTime: new Date(completionObservedAt + (24 * 60 * 60 * 1000)).toISOString()
}, { now: completionObservedAt });
assert.equal(
  boundedCompletion.jobs[0].tasks[0].completedAt,
  completionObservedAt,
  "A future native endTime must be bounded to the observation time"
);

working = Queue.applyDownloadChange(working, 102, {
  state: { current: "interrupted" },
  error: { current: "NETWORK_FAILED" },
  bytesReceived: { current: 25 },
  totalBytes: { current: 200 }
}, { now: BASE_TIME + 9 });
assert.equal(working.jobs[0].tasks[1].status, "interrupted");
assert.equal(working.jobs[0].tasks[1].error, "NETWORK_FAILED");
assert.equal(working.stats.lifetime.interrupted, 1);
assert.equal(working.history.length, 0, "A job with a queued task is not history yet");

claim = Queue.claimNextTasks(working, { concurrency: 2, now: BASE_TIME + 10 });
assert.equal(claim.tasks.length, 1);
working = Queue.bindDownload(claim.state, claim.tasks[0].id, 103, { now: BASE_TIME + 11 });
working = Queue.applyDownloadSnapshots(working, [{
  id: 103,
  state: "complete",
  bytesReceived: 300,
  totalBytes: 300
}], { now: BASE_TIME + 12 });
assert.equal(working.jobs[0].status, "interrupted");
assert.equal(working.history.length, 1);
assert.deepEqual({
  total: working.history[0].total,
  completed: working.history[0].completed,
  interrupted: working.history[0].interrupted,
  bytesDownloaded: working.history[0].bytesDownloaded
}, {
  total: 3,
  completed: 2,
  interrupted: 1,
  bytesDownloaded: 400
});

const summary = Queue.progressSummary(working, working.jobs[0].id, { now: BASE_TIME + 13 });
assert.equal(summary.total, 3);
assert.equal(summary.complete, 2);
assert.equal(summary.interrupted, 1);
assert.equal(summary.finished, 3);
assert.equal(summary.percent, 71);
assert.equal(Queue.progressSummary(working, "missing", { now: BASE_TIME }), null);
assert.equal(Queue.progressSummary(working, "", { now: BASE_TIME }).total, 3);

let retriedResult = Queue.retryFailures(working, {
  jobId: working.jobs[0].id,
  now: BASE_TIME + 14
});
working = retriedResult.state;
assert.equal(retriedResult.retried, 1);
const retriedTask = working.jobs[0].tasks[1];
assert.equal(retriedTask.status, "queued");
assert.equal(retriedTask.attempt, 2);
assert.equal(retriedTask.downloadId, null);
assert.equal(working.history.length, 0, "Retrying reopens the terminal job");
assert.equal(working.stats.lifetime.interrupted, 1, "Historical failed attempts remain statistics");
claim = Queue.claimNextTasks(working, { concurrency: 1, now: BASE_TIME + 15 });
working = Queue.bindDownload(claim.state, claim.tasks[0].id, 104, { now: BASE_TIME + 16 });
working = Queue.applyDownloadSnapshot(working, {
  id: 104,
  state: "complete",
  bytesReceived: 200,
  totalBytes: 200
}, { now: BASE_TIME + 17 });
assert.equal(working.stats.lifetime.completed, 3);
assert.equal(working.stats.lifetime.interrupted, 1);
assert.equal(working.stats.lifetime.bytesDownloaded, 600);
assert.equal(working.history.length, 1);
assert.equal(working.history[0].status, "complete");

let reconciled = enqueue(Queue.emptyState(BASE_TIME), 2).state;
let reconcileClaim = Queue.claimNextTasks(reconciled, { concurrency: 2, now: BASE_TIME + 1 });
reconciled = Queue.bindDownload(reconcileClaim.state, reconcileClaim.tasks[0].id, 201, {
  now: BASE_TIME + 2
});
reconciled = Queue.bindDownload(reconciled, reconcileClaim.tasks[1].id, 202, {
  now: BASE_TIME + 2
});
reconciled = Queue.applyDownloadSnapshots(reconciled, [{
  id: 201,
  state: "complete",
  bytesReceived: 50,
  totalBytes: 50
}], { now: BASE_TIME + 3, markMissing: true });
assert.deepEqual(reconciled.jobs[0].tasks.map((task) => task.status), ["complete", "interrupted"]);
assert.match(reconciled.jobs[0].tasks[1].error, /no longer exists/i);
assert.equal(reconciled.stats.lifetime.completed, 1);
assert.equal(reconciled.stats.lifetime.interrupted, 1);

let cancellation = enqueue(Queue.emptyState(BASE_TIME), 1).state;
const cancelledTaskId = cancellation.jobs[0].tasks[0].id;
cancellation = Queue.cancelTask(cancellation, cancelledTaskId, {
  now: BASE_TIME + 1,
  reason: "User cancelled"
});
assert.equal(cancellation.jobs[0].status, "cancelled");
assert.equal(cancellation.stats.lifetime.cancelled, 1);
assert.equal(Queue.retryFailures(cancellation, { now: BASE_TIME + 2 }).retried, 0);
const retryCancelled = Queue.retryFailures(cancellation, {
  now: BASE_TIME + 2,
  includeCancelled: true
});
assert.equal(retryCancelled.retried, 1);
assert.equal(retryCancelled.state.jobs[0].tasks[0].status, "queued");

let targeted = enqueue(Queue.emptyState(BASE_TIME), 3, { saveAs: true }).state;
let targetedClaim = Queue.claimNextTasks(targeted, {
  concurrency: 3,
  now: BASE_TIME + 1
});
targeted = Queue.bindDownload(targetedClaim.state, targetedClaim.tasks[0].id, 301, {
  now: BASE_TIME + 2
});
targeted = Queue.bindDownload(targeted, targetedClaim.tasks[1].id, 302, {
  now: BASE_TIME + 2
});
targeted = Queue.bindDownload(targeted, targetedClaim.tasks[2].id, 303, {
  now: BASE_TIME + 2
});
targeted = Queue.applyDownloadSnapshot(targeted, {
  id: 301,
  state: "interrupted",
  error: "NETWORK_FAILED"
}, { now: BASE_TIME + 3 });
targeted = Queue.applyDownloadSnapshot(targeted, {
  id: 302,
  state: "interrupted",
  error: "SERVER_FAILED"
}, { now: BASE_TIME + 3 });
targeted = Queue.cancelTask(targeted, targetedClaim.tasks[2].id, {
  now: BASE_TIME + 3
});
assert.equal(targeted.history.length, 1);
assert.equal(targeted.stats.lifetime.interrupted, 2);
assert.equal(targeted.stats.lifetime.cancelled, 1);

const targetedInput = targeted;
let targetedRetry = Queue.retryTask(targeted, targetedClaim.tasks[0].id, {
  now: BASE_TIME + 4
});
targeted = targetedRetry.state;
assert.equal(targetedRetry.retried, 1);
assert.equal(targetedInput.jobs[0].tasks[0].status, "interrupted", "Targeted retry must be pure");
assert.equal(targeted.jobs[0].tasks[0].status, "queued");
assert.equal(targeted.jobs[0].tasks[0].attempt, 2);
assert.equal(targeted.jobs[0].tasks[0].recordedAttempt, 1);
assert.equal(targeted.jobs[0].tasks[1].status, "interrupted", "Sibling failures must stay untouched");
assert.equal(targeted.jobs[0].tasks[2].status, "cancelled", "Sibling cancellations must stay untouched");
assert.equal(targeted.history.length, 0, "Retrying one task reopens its terminal job");
assert.equal(targeted.stats.lifetime.interrupted, 2, "Retrying does not erase prior outcomes");
assert.equal(targeted.stats.lifetime.cancelled, 1);

const cancelledNotIncluded = Queue.retryTask(targeted, targetedClaim.tasks[2].id, {
  now: BASE_TIME + 5
});
assert.equal(cancelledNotIncluded.retried, 0);
const cancelledIncluded = Queue.retryTask(targeted, targetedClaim.tasks[2].id, {
  now: BASE_TIME + 5,
  includeCancelled: true
});
assert.equal(cancelledIncluded.retried, 1);
assert.equal(cancelledIncluded.state.jobs[0].tasks[2].status, "queued");
assert.equal(cancelledIncluded.state.jobs[0].tasks[2].attempt, 2);
assert.equal(cancelledIncluded.state.stats.lifetime.cancelled, 1);

targetedClaim = Queue.claimNextTasks(targeted, {
  concurrency: 1,
  now: BASE_TIME + 6
});
targeted = Queue.bindDownload(targetedClaim.state, targetedClaim.tasks[0].id, 304, {
  now: BASE_TIME + 7
});
targeted = Queue.applyDownloadSnapshot(targeted, {
  id: 304,
  state: "complete",
  bytesReceived: 75,
  totalBytes: 75
}, { now: BASE_TIME + 8 });
targeted = Queue.applyDownloadSnapshot(targeted, {
  id: 304,
  state: "complete",
  bytesReceived: 75,
  totalBytes: 75
}, { now: BASE_TIME + 9 });
assert.equal(targeted.stats.lifetime.completed, 1);
assert.equal(targeted.stats.lifetime.interrupted, 2);
assert.equal(targeted.stats.lifetime.bytesDownloaded, 75);

const saturatedAttempt = Queue.hydrate({
  schemaVersion: Queue.SCHEMA_VERSION,
  jobs: [{
    id: "saturated-job",
    saveAs: true,
    tasks: [{
      id: "saturated-task",
      url: "https://images.example/saturated.jpg",
      status: "interrupted",
      attempt: 1000000,
      recordedAttempt: 1000000,
      createdAt: BASE_TIME,
      completedAt: BASE_TIME
    }]
  }]
}, { now: BASE_TIME });
assert.equal(saturatedAttempt.jobs[0].saveAs, true);
assert.equal(
  Queue.retryTask(saturatedAttempt, "saturated-task", { now: BASE_TIME + 1 }).retried,
  0,
  "A saturated attempt counter must not reuse its exact-once idempotency key"
);

let startFailure = enqueue(Queue.emptyState(BASE_TIME), 1).state;
const startFailureClaim = Queue.claimNextTasks(startFailure, {
  concurrency: 1,
  now: BASE_TIME + 1
});
startFailure = Queue.interruptTask(
  startFailureClaim.state,
  startFailureClaim.tasks[0].id,
  "downloads.download rejected",
  { now: BASE_TIME + 2 }
);
assert.equal(startFailure.jobs[0].tasks[0].status, "interrupted");
assert.equal(startFailure.stats.lifetime.interrupted, 1);
assert.match(startFailure.jobs[0].tasks[0].error, /rejected/);

const cleared = Queue.clearCompleted(working, { now: BASE_TIME + 18 });
assert.equal(cleared.removed, 3);
assert.equal(cleared.state.jobs.length, 0);
assert.equal(cleared.state.history.length, 1, "Clearing queue entries keeps bounded history");
const historyCleared = Queue.clearHistory(cleared.state, { now: BASE_TIME + 19 });
assert.equal(historyCleared.removed, 1);
assert.equal(historyCleared.state.history.length, 0);

const mixedClear = Queue.clearCompleted(reconciled, { now: BASE_TIME + 4 });
assert.equal(mixedClear.removed, 0, "Completed files stay attached to a retryable mixed-result job");
assert.equal(mixedClear.state.jobs[0].tasks.length, 2);

const restartState = Queue.hydrate({
  schemaVersion: 1,
  jobs: [{
    id: "restart-job",
    label: "Restart",
    saveAs: true,
    tasks: [{
      id: "unbound",
      url: "https://images.example/unbound.jpg",
      status: "starting",
      attempt: 1,
      createdAt: BASE_TIME
    }, {
      id: "bound",
      url: "https://images.example/bound.jpg",
      status: "in_progress",
      downloadId: 77,
      attempt: 1,
      createdAt: BASE_TIME
    }]
  }],
  stats: {
    lifetime: { enqueued: 20, completed: 10, bytesDownloaded: 1234 },
    today: { date: PREVIOUS_DAY, enqueued: 9, completed: 9, bytesDownloaded: 999 }
  }
}, { now: BASE_TIME });
assert.equal(restartState.jobs[0].tasks[0].status, "queued", "Unbound starts recover after restart");
assert.equal(restartState.jobs[0].tasks[1].status, "in_progress", "Bound downloads await search reconciliation");
assert.equal(restartState.jobs[0].saveAs, true, "saveAs survives queue hydration");
assert.equal(restartState.stats.lifetime.completed, 10);
assert.equal(restartState.stats.today.date, BASE_DAY);
assert.equal(restartState.stats.today.completed, 0, "Daily counters roll over safely");

const migrated = Queue.hydrate({
  jobs: [{
    id: "legacy-job",
    tasks: [{
      id: "legacy-task",
      url: "https://images.example/legacy.jpg",
      status: "complete",
      bytesReceived: 88,
      createdAt: BASE_TIME,
      completedAt: BASE_TIME
    }]
  }]
}, { now: BASE_TIME });
assert.equal(migrated.schemaVersion, Queue.SCHEMA_VERSION);
assert.equal(migrated.stats.lifetime.enqueued, 1);
assert.equal(migrated.stats.lifetime.completed, 1);
assert.equal(migrated.stats.lifetime.bytesDownloaded, 88);
assert.equal(migrated.jobs[0].tasks[0].recordedAttempt, 1);
const migratedReplay = Queue.applyDownloadSnapshot(
  { ...migrated, jobs: [{ ...migrated.jobs[0], tasks: [{ ...migrated.jobs[0].tasks[0], downloadId: 55 }] }] },
  { id: 55, state: "complete", bytesReceived: 88 },
  { now: BASE_TIME + 1 }
);
assert.equal(migratedReplay.stats.lifetime.completed, 1);

assert.deepEqual(
  Queue.hydrate({ schemaVersion: 999, jobs: [{ id: "future" }] }, { now: BASE_TIME }),
  Queue.emptyState(BASE_TIME),
  "Unknown future schemas reset instead of being misinterpreted"
);
for (const malformed of [null, undefined, 42, "state", [], { jobs: [null, 4, "bad"] }]) {
  assert.doesNotThrow(() => Queue.hydrate(malformed, { now: BASE_TIME }));
  assert.equal(Queue.hydrate(malformed, { now: BASE_TIME }).schemaVersion, 1);
}
const hostile = {};
Object.defineProperty(hostile, "jobs", {
  get() {
    throw new Error("hostile getter");
  }
});
assert.doesNotThrow(() => Queue.hydrate(hostile, { now: BASE_TIME }));

const sixHundred = enqueue(Queue.emptyState(BASE_TIME), 600);
assert.equal(sixHundred.accepted, 600, "Large galleries above 500 items remain supported");
assert.equal(sixHundred.state.jobs[0].tasks.length, 600);
const overLimit = enqueue(Queue.emptyState(BASE_TIME), 1600);
assert.equal(overLimit.accepted, Queue.MAX_BATCH_SIZE);
assert.equal(overLimit.state.jobs[0].tasks.length, Queue.MAX_STORED_TASKS);
assert.equal(overLimit.rejected[overLimit.rejected.length - 1].count, 100);
const noCapacity = enqueue(overLimit.state, 1);
assert.equal(noCapacity.accepted, 0);
assert.match(noCapacity.rejected[0].error, /capacity/i);

const allTaskIds = overLimit.state.jobs[0].tasks.map((task) => task.id);
const bulkPaused = Queue.setTasksPaused(overLimit.state, allTaskIds, true, {
  now: BASE_TIME + 1
});
assert.equal(bulkPaused.updated, Queue.MAX_STORED_TASKS);
assert.ok(bulkPaused.state.jobs[0].tasks.every((task) => task.status === "paused"));
assert.ok(overLimit.state.jobs[0].tasks.every((task) => task.status === "queued"));
assert.ok(
  Queue.hydrate(bulkPaused.state, { now: BASE_TIME + 1 }).jobs[0].tasks
    .every((task) => task.status === "paused"),
  "Queued tasks paused by the user must remain paused after a background restart"
);
const bulkCancelled = Queue.cancelTasks(bulkPaused.state, allTaskIds, {
  now: BASE_TIME + 2,
  reason: "Bulk cancellation"
});
assert.equal(bulkCancelled.cancelled, Queue.MAX_STORED_TASKS);
assert.equal(bulkCancelled.state.stats.lifetime.cancelled, Queue.MAX_STORED_TASKS);
assert.ok(bulkCancelled.state.jobs[0].tasks.every((task) => task.error === "Bulk cancellation"));

let jobLimited = Queue.emptyState(BASE_TIME);
for (let index = 0; index < Queue.MAX_STORED_JOBS; index += 1) {
  jobLimited = Queue.enqueueBatch(jobLimited, [{
    url: `https://images.example/job-limit-${index}.jpg`
  }], {
    now: BASE_TIME + index,
    idFactory: (kind) => `${kind}-limit-${index}`
  }).state;
}
const extraJob = Queue.enqueueBatch(jobLimited, [{
  url: "https://images.example/one-job-too-many.jpg"
}], { now: BASE_TIME + 101 });
assert.equal(extraJob.accepted, 0);
assert.match(extraJob.rejected[0].error, /capacity/i);
assert.equal(extraJob.state.jobs.length, Queue.MAX_STORED_JOBS);

const oversizedUrl = `data:image/png;base64,${"A".repeat(499900)}`;
const urlLimited = Queue.enqueueBatch(
  Queue.emptyState(BASE_TIME),
  Array.from({ length: 10 }, () => oversizedUrl),
  { now: BASE_TIME, idFactory: deterministicIds }
);
assert.ok(urlLimited.accepted > 0 && urlLimited.accepted < 10);
assert.ok(
  urlLimited.state.jobs[0].tasks.reduce((sum, task) => sum + task.url.length, 0) <= 2000000,
  "Persisted URL data must remain within the core batch limit"
);

let boundedHistory = Queue.emptyState(BASE_TIME);
for (let index = 0; index < Queue.MAX_HISTORY_ITEMS + 7; index += 1) {
  const added = Queue.enqueueBatch(boundedHistory, [{
    url: `https://images.example/history-${index}.jpg`
  }], {
    now: BASE_TIME + index * 10,
    idFactory: (kind) => `${kind}-history-${index}`,
    label: `History ${index}`
  });
  const started = Queue.claimNextTasks(added.state, {
    concurrency: 1,
    now: BASE_TIME + index * 10 + 1
  });
  boundedHistory = Queue.bindDownload(
    started.state,
    started.tasks[0].id,
    1000 + index,
    { now: BASE_TIME + index * 10 + 2 }
  );
  boundedHistory = Queue.applyDownloadSnapshot(boundedHistory, {
    id: 1000 + index,
    state: "complete",
    bytesReceived: index + 1,
    totalBytes: index + 1
  }, { now: BASE_TIME + index * 10 + 3 });
  boundedHistory = Queue.clearCompleted(boundedHistory, {
    now: BASE_TIME + index * 10 + 4
  }).state;
}
assert.equal(boundedHistory.history.length, Queue.MAX_HISTORY_ITEMS);
assert.equal(boundedHistory.history[0].label, "History 7");
assert.equal(boundedHistory.history[boundedHistory.history.length - 1].label, "History 106");
assert.equal(boundedHistory.stats.lifetime.completed, 107);
assert.equal(boundedHistory.stats.lifetime.enqueued, 107);

console.log("All durable download queue/history checks passed.");
