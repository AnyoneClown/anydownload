"use strict";

// Synthetic model timings exclude Firefox, disk and network latency. Keep them
// separate from correctness tests: elapsed time varies by machine and runtime.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const modulePath = "extension/shared/download-queue.js";
const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline-ref="));
const baselineRef = baselineArg && baselineArg.slice("--baseline-ref=".length);
const now = Date.UTC(2026, 9, 16, 12);

function loadModel(source) {
  const context = vm.createContext({ URL, Date });
  vm.runInContext(source, context, { filename: modulePath });
  return context.ImageDownloaderDownloadQueue;
}

function fixture(Queue, completed = false) {
  return Queue.hydrate({
    schemaVersion: 1,
    jobs: Array.from({ length: 4 }, (_, jobIndex) => ({
      id: `job-${jobIndex}`, createdAt: now, updatedAt: now,
      tasks: Array.from({ length: 1250 }, (_, taskIndex) => {
        const index = jobIndex * 1250 + taskIndex;
        return {
          id: `task-${index}`, url: `https://media.example/${index}.jpg`,
          filename: `${index}.jpg`, createdAt: now, updatedAt: now,
          status: completed ? "complete" : index < 3 ? "in_progress" : "queued",
          downloadId: completed || index < 3 ? index + 1 : null,
          attempt: completed || index < 3 ? 1 : 0,
          recordedAttempt: completed ? 1 : 0,
          needsReconciliation: completed,
          completedAt: completed ? now : 0
        };
      })
    }))
  }, { now, recoverInFlight: false });
}

function medianTime(action, iterations) {
  for (let index = 0; index < 3; index += 1) action();
  const samples = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) action();
    samples.push((performance.now() - start) / iterations);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

function benchmark(Queue) {
  const progressState = fixture(Queue);
  const progress = () => Queue.applyDownloadChange(progressState, 1, {
    bytesReceived: { current: 128 }, totalBytes: { current: 1024 }
  }, { now: now + 1 });
  const next = progress();
  assert.equal(progressState.jobs[0].tasks[0].bytesReceived, 0);
  assert.equal(next.jobs[0].tasks[0].bytesReceived, 128);
  const clonedTasks = next.jobs.reduce((count, job, jobIndex) => count +
    job.tasks.filter((task, index) => task !== progressState.jobs[jobIndex].tasks[index]).length, 0);
  const completedState = fixture(Queue, true);
  const snapshots = completedState.jobs.flatMap((job) => job.tasks.map((task) => ({
    id: task.downloadId, state: "complete", bytesReceived: 2048, totalBytes: 2048
  })));
  const reconcile = () => Queue.applyDownloadSnapshots(completedState, snapshots, { now: now + 1 });
  assert.equal(reconcile().jobs[3].tasks[1249].needsReconciliation, false);
  return {
    "Progress event, 5,000 tasks": medianTime(progress, 100),
    "Reconcile 5,000 completed downloads": medianTime(reconcile, 1),
    clonedTasks
  };
}

const current = benchmark(loadModel(fs.readFileSync(path.join(root, modulePath), "utf8")));
const baseline = baselineRef ? benchmark(loadModel(execFileSync("git", [
  "show", `${baselineRef}:${modulePath}`
], { cwd: root, encoding: "utf8" }))) : null;
console.log(`Queue model benchmarks (${process.version}; median of 7 samples; milliseconds per operation)`);
console.table(Object.entries(current).filter(([name]) => name !== "clonedTasks").map(([scenario, ms]) => ({
  scenario, current_ms: Number(ms.toFixed(3)),
  ...(baseline ? {
    baseline_ms: Number(baseline[scenario].toFixed(3)),
    speedup: `${(baseline[scenario] / ms).toFixed(2)}x`
  } : {})
})));
console.log(`Task objects copied per progress event: ${current.clonedTasks}` +
  (baseline ? ` (baseline: ${baseline.clonedTasks})` : ""));
