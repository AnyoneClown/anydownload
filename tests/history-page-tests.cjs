"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const historySource = fs.readFileSync(
  path.resolve(__dirname, "../extension/history/history.js"),
  "utf8"
);

const historyHtml = fs.readFileSync(path.resolve(__dirname, "../extension/history/history.html"), "utf8");
const ELEMENT_IDS = Array.from(historyHtml.matchAll(/\bid="([^"]+)"/g), match => match[1]);
assert.equal(new Set(ELEMENT_IDS).size, ELEMENT_IDS.length, "History IDs must remain unique");

class FakeElement {
  constructor(tagName, id) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.id = id || "";
    this.children = [];
    this.className = "";
    this.disabled = false;
    this.dataset = {};
    this.hidden = false;
    this.listeners = new Map();
    this.max = 1;
    this.replaceCount = 0;
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.value = id === "status-filter" ? "all" : id === "search-input" ? "" : 0;
    this.valueWrites = 0;
  }

  get value() { return this.storedValue; }
  set value(value) { this.storedValue = value; this.valueWrites = (this.valueWrites || 0) + 1; }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append(...children) {
    for (const child of children) {
      if (child && child.isFragment) {
        this.children.push(...child.children);
      } else {
        this.children.push(child);
      }
    }
    this.children.forEach((child) => { child.parentElement = this; });
  }

  setAttribute(name, value) { this[name] = value; }

  focus() { this.ownerDocument.activeElement = this; }

  closest(selector) {
    if (selector === "[data-focus-scope]" && this.dataset.focusScope ||
        selector === ".job-card" && this.className === "job-card") {
      return this;
    }
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  querySelectorAll() {
    return descendants(this).filter((element) => element.dataset.focusKey || element.dataset.focusScope);
  }

  replaceChildren(...children) {
    this.replaceCount += 1;
    this.children = [];
    this.append(...children);
  }

  async dispatch(type) {
    const listener = this.listeners.get(type);
    if (listener) {
      await listener({ currentTarget: this, target: this, type });
    }
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map(ELEMENT_IDS.map((id) => [id, new FakeElement("div", id)]));
    this.listeners = new Map();
    this.activeElement = null;
    this.elements.forEach((element) => { element.ownerDocument = this; });
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  createDocumentFragment() {
    const fragment = new FakeElement("fragment");
    fragment.isFragment = true;
    return fragment;
  }

  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  async dispatch(type) {
    const listener = this.listeners.get(type);
    if (listener) {
      await listener({ type });
    }
  }
}

function emptySnapshot(overrides) {
  return {
    summary: {
      total: 0,
      queued: 0,
      active: 0,
      paused: 0,
      complete: 0,
      failed: 0,
      cancelled: 0,
      ...(overrides && overrides.summary)
    },
    stats: {
      lifetime: {
        completed: 0,
        failed: 0,
        cancelled: 0,
        bytes: 0,
        ...(overrides && overrides.stats && overrides.stats.lifetime)
      },
      today: {
        completed: 0,
        failed: 0,
        cancelled: 0,
        bytes: 0,
        ...(overrides && overrides.stats && overrides.stats.today)
      }
    },
    jobs: overrides && overrides.jobs || []
  };
}

function descendants(element) {
  const found = [];
  for (const child of element.children || []) {
    if (!child) {
      continue;
    }
    found.push(child, ...descendants(child));
  }
  return found;
}

async function loadHistoryPage({ snapshot, tabs, windows, extension, downloads }) {
  const document = new FakeDocument();
  const messages = [];
  const browser = {
    downloads,
    extension: extension || { inIncognitoContext: false },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return { ok: true, snapshot };
      }
    },
    tabs,
    windows
  };
  const context = {
    addEventListener() {},
    browser,
    clearTimeout() {},
    document,
    URL,
    setTimeout() {
      return 1;
    }
  };
  vm.createContext(context);
  vm.runInContext(historySource, context, { filename: "history.js" });
  await document.dispatch("DOMContentLoaded");
  return { document, messages };
}

async function exercisePrivateContextAndStats() {
  let windowLookupCount = 0;
  const snapshot = emptySnapshot({
    stats: {
      lifetime: { completed: 18, failed: 2, cancelled: 1, bytes: 4096 },
      today: { completed: 8, failed: 1, cancelled: 1, bytes: 2048 }
    }
  });
  const page = await loadHistoryPage({
    snapshot,
    tabs: { async getCurrent() { return { incognito: true }; } },
    windows: { async getCurrent() { windowLookupCount += 1; return { incognito: false }; } },
    extension: { inIncognitoContext: false },
    downloads: { async showDefaultFolder() {} }
  });

  assert.equal(page.messages[0].type, "GET_DOWNLOAD_DASHBOARD");
  assert.equal(page.messages[0].incognito, true, "The owning tab must select the private queue");
  assert.equal(windowLookupCount, 0, "A conclusive current tab must avoid a second context lookup");
  assert.match(page.document.getElementById("dashboard-subtitle").textContent, /^Private queue/);
  assert.equal(
    page.document.getElementById("completed-detail").textContent,
    "8"
  );
  assert.equal(
    page.document.getElementById("success-detail").textContent,
    "80%"
  );
}

async function exerciseWindowContextFallback() {
  const page = await loadHistoryPage({
    snapshot: emptySnapshot(),
    tabs: { async getCurrent() { return null; } },
    windows: { async getCurrent() { return { incognito: true }; } },
    extension: { inIncognitoContext: false },
    downloads: { async showDefaultFolder() {} }
  });
  assert.equal(page.messages[0].incognito, true, "The owning window must be used when no current tab is returned");
}

async function exerciseRetryControls() {
  const cancelledOnly = emptySnapshot({
    summary: { total: 1, cancelled: 1 },
    jobs: [{
      id: "cancelled-job",
      label: "Cancelled batch",
      folder: "images",
      status: "cancelled",
      createdAt: Date.now(),
      historyOnly: false,
      counts: { total: 1, complete: 0, failed: 0, cancelled: 1, pending: 0 },
      tasks: [{
        id: "cancelled-task",
        filename: "cancelled.jpg",
        status: "cancelled",
        downloadId: null,
        bytesReceived: 0,
        totalBytes: 0,
        error: ""
      }]
    }]
  });
  const cancelledPage = await loadHistoryPage({
    snapshot: cancelledOnly,
    tabs: { async getCurrent() { return { incognito: false }; } },
    downloads: { async showDefaultFolder() {} }
  });
  const cancelledGlobalRetry = cancelledPage.document.getElementById("retry-failed-button");
  assert.equal(cancelledGlobalRetry.disabled, true);
  assert.equal(cancelledGlobalRetry.hidden, true);
  const cancelledButtons = descendants(cancelledPage.document.getElementById("job-list"))
    .filter((element) => element.tagName === "BUTTON")
    .map((element) => element.textContent);
  assert.ok(cancelledButtons.includes("Retry"), "A cancelled file must retain its individual Retry action");
  assert.ok(!cancelledButtons.includes("Retry failed"), "A cancelled-only batch must not offer bulk Retry failed");

  const failed = emptySnapshot({
    summary: { total: 2, failed: 1, cancelled: 1 },
    jobs: [{
      id: "failed-job",
      label: "Mixed batch",
      folder: "images",
      status: "partial",
      createdAt: Date.now(),
      historyOnly: false,
      counts: { total: 2, complete: 0, failed: 1, cancelled: 1, pending: 0 },
      tasks: []
    }]
  });
  const failedPage = await loadHistoryPage({
    snapshot: failed,
    tabs: { async getCurrent() { return { incognito: false }; } },
    downloads: { async showDefaultFolder() {} }
  });
  const failedGlobalRetry = failedPage.document.getElementById("retry-failed-button");
  assert.equal(failedGlobalRetry.disabled, false);
  assert.equal(failedGlobalRetry.hidden, false);
  const failedButtons = descendants(failedPage.document.getElementById("job-list"))
    .filter((element) => element.tagName === "BUTTON")
    .map((element) => element.textContent);
  assert.ok(failedButtons.includes("Retry failed"));
}

async function exerciseUnchangedRefreshSkipsDomRebuild() {
  const page = await loadHistoryPage({
    snapshot: emptySnapshot(),
    tabs: { async getCurrent() { return { incognito: false }; } },
    downloads: { async showDefaultFolder() {} }
  });
  const jobList = page.document.getElementById("job-list");
  assert.equal(jobList.replaceCount, 1);
  await page.document.getElementById("refresh-button").dispatch("click");
  assert.equal(
    jobList.replaceCount,
    1,
    "Polling an unchanged dashboard must not rebuild its job DOM"
  );
}

async function exerciseDownloadsApiFailures() {
  const snapshot = emptySnapshot({
    summary: { total: 1, complete: 1 },
    jobs: [{
      id: "complete-job",
      label: "Complete batch",
      folder: "images",
      status: "complete",
      createdAt: Date.now(),
      historyOnly: false,
      counts: { total: 1, complete: 1, failed: 0, cancelled: 0, pending: 0 },
      tasks: [{
        id: "complete-task",
        filename: "complete.jpg",
        status: "complete",
        downloadId: 17,
        bytesReceived: 1024,
        totalBytes: 1024,
        error: ""
      }]
    }]
  });
  const page = await loadHistoryPage({
    snapshot,
    tabs: { async getCurrent() { return { incognito: false }; } },
    downloads: {
      async show() { throw new Error("Could not reveal file"); },
      async showDefaultFolder() { throw new Error("Could not open folder"); }
    }
  });
  await page.document.getElementById("open-folder-button").dispatch("click");
  assert.equal(page.document.getElementById("error-banner").textContent, "Could not open folder");

  const showButton = descendants(page.document.getElementById("job-list"))
    .find((element) => element.tagName === "BUTTON" && element.textContent === "Show");
  assert.ok(showButton);
  await showButton.dispatch("click");
  assert.equal(page.document.getElementById("error-banner").textContent, "Could not reveal file");

  const unsupportedPage = await loadHistoryPage({
    snapshot,
    tabs: { async getCurrent() { return { incognito: false }; } },
    downloads: {}
  });
  assert.equal(unsupportedPage.document.getElementById("open-folder-button").disabled, true);
  const unsupportedShow = descendants(unsupportedPage.document.getElementById("job-list"))
    .find((element) => element.tagName === "BUTTON" && element.textContent === "Show");
  assert.equal(unsupportedShow, undefined, "Unavailable file actions must not create disabled rows");
  assert.equal(unsupportedPage.document.getElementById("open-folder-button").hidden, true);
}

async function exerciseFileFiltersAndLiveFocus() {
  const snapshot = emptySnapshot({
    summary: { total: 3, active: 1, failed: 1, complete: 1 },
    jobs: [{
      id: "mixed-job", label: "Photos", source: "https://gallery.example/album", status: "in_progress",
      counts: { total: 3, active: 1, failed: 1, complete: 1, pending: 1 },
      tasks: [
        { id: "active", filename: "active.jpg", status: "in_progress", bytesReceived: 1 },
        { id: "failed", filename: "missing.jpg", status: "interrupted" },
        { id: "complete", filename: "saved.jpg", status: "complete" }
      ]
    }]
  });
  const page = await loadHistoryPage({ snapshot, downloads: {} });
  const list = page.document.getElementById("job-list");
  const filter = page.document.getElementById("status-filter");
  filter.value = "failed";
  await filter.dispatch("change");
  assert.deepEqual(descendants(list).filter((element) => element.className === "task-title").map((element) => element.textContent), ["missing.jpg"],
    "Failed files in active batches must be discoverable without showing unrelated files");
  const retry = descendants(list).find((element) => element.dataset.focusKey === "task:failed:retry");
  retry.focus();
  snapshot.jobs[0].tasks[0].bytesReceived = 2;
  await page.document.getElementById("refresh-button").dispatch("click");
  assert.notEqual(page.document.activeElement, retry, "The test must exercise an actual DOM rebuild");
  assert.equal(page.document.activeElement.dataset.focusKey, "task:failed:retry");
  snapshot.jobs[0].tasks[1].status = "queued";
  await page.document.activeElement.dispatch("click");
  assert.equal(page.document.activeElement, filter, "When the retried row leaves the filter, focus must reach a usable control");
  filter.value = "all";
  await filter.dispatch("change");
  const pause = descendants(list).find((element) => element.dataset.focusKey === "task:active:pause");
  pause.focus();
  snapshot.jobs[0].tasks[0].status = "paused";
  await pause.dispatch("click");
  assert.equal(page.document.activeElement.dataset.focusScope, "task:active", "A changed task action must keep focus in its own row");
  const search = page.document.getElementById("search-input");
  search.value = "SAVED.JPG";
  await search.dispatch("input");
  assert.deepEqual(descendants(list).filter((element) => element.className === "task-title").map((element) => element.textContent), ["saved.jpg"]);
  search.value = "gallery.example";
  await search.dispatch("input");
  assert.equal(descendants(list).filter((element) => element.className === "task-row").length, 3);
  search.value = "does-not-exist";
  await search.dispatch("input");
  assert.equal(list.children.length, 0);
  assert.equal(page.document.getElementById("history-empty").hidden, false);
}

async function exerciseCompactEmptyAndStatistics() {
  assert.match(historyHtml, /<body class="downloads-page">/, "Downloads owns its compact layout");
  assert.doesNotMatch(historyHtml, /stats-grid|stat-card|eyebrow|section-label/);
  assert.match(historyHtml, /<details id="statistics-panel"[^>]*hidden>/);
  assert.doesNotMatch(historyHtml, /<details id="statistics-panel"[^>]*\bopen\b/,
    "Lifetime totals must stay collapsed until requested");
  const page = await loadHistoryPage({ snapshot: emptySnapshot(), downloads: {} });
  const get = id => page.document.getElementById(id);
  assert.equal(get("history-empty-title").textContent, "No downloads yet");
  assert.equal(get("history-empty-detail").textContent, "Select files in Media to start downloading.");
  for (const id of ["queue-section", "history-tools", "statistics-panel", "pause-all-button",
    "resume-all-button", "cancel-pending-button", "retry-failed-button", "clear-completed-button"]) {
    assert.equal(get(id).hidden, true, `An empty page must not show ${id}`);
  }
  const populated = await loadHistoryPage({ snapshot: emptySnapshot({ stats: {
    lifetime: { completed: 8, failed: 1, cancelled: 1, bytes: 8192 },
    today: { completed: 2, failed: 0, cancelled: 0, bytes: 2048 }
  } }), downloads: {} });
  const stats = id => populated.document.getElementById(id);
  assert.equal(stats("statistics-panel").hidden, false);
  assert.equal(stats("completed-stat").textContent, "8");
  assert.equal(stats("failed-stat").textContent, "1");
  assert.equal(stats("cancelled-stat").textContent, "1");
  assert.equal(stats("bytes-stat").textContent, "8 KiB");
  assert.equal(stats("success-stat").textContent, "80%");
  assert.equal(stats("success-detail").textContent, "100%");
  assert.equal(stats("history-empty-title").textContent, "No recent downloads",
    "Cleared detailed history must not imply the user has never downloaded anything");
}

async function exerciseUsefulBatchRowsAndIndeterminateSizes() {
  const snapshot = emptySnapshot({
    summary: { total: 4, active: 1, queued: 1, complete: 1, failed: 1 },
    jobs: [
      { id: "archived", label: "Earlier photos", folder: "Earlier", status: "complete", historyOnly: true,
        createdAt: 1700000000000, finishedAt: 1700000005000,
        counts: { total: 40, complete: 40, failed: 0, cancelled: 0, pending: 0 }, tasks: [] },
      { id: "current", label: "Summer trip", source: "https://photos.example/trips/2026?token=private",
        folder: "Summer", status: "active", createdAt: 1700000010000, historyOnly: false,
        counts: { total: 4, complete: 1, active: 1, queued: 1, failed: 1, cancelled: 0, pending: 2 },
        tasks: [
          { id: "saved", filename: "/home/me/Downloads/Summer/photo.jpg", status: "complete", bytesReceived: 2048, totalBytes: 2048 },
          { id: "loading", filename: "loading.jpg", status: "in_progress", bytesReceived: 1024, totalBytes: 0 },
          { id: "waiting", filename: "waiting.jpg", status: "queued", bytesReceived: 0, totalBytes: 0 },
          { id: "broken", filename: "broken.jpg", status: "interrupted", error: "Server returned 404", bytesReceived: 0, totalBytes: 0 }
        ] }
    ]
  });
  const page = await loadHistoryPage({ snapshot, downloads: {} });
  const get = id => page.document.getElementById(id);
  const rows = get("job-list").children;
  assert.equal(rows[0].dataset.focusScope, "job:current", "Active batches take priority over recorded history");
  const current = descendants(rows[0]);
  const source = current.find(element => element.className === "job-source");
  assert.equal(source.textContent, "photos.example/trips/2026");
  assert.equal(source.href, snapshot.jobs[1].source);
  assert.equal(source.rel, "noopener noreferrer");
  assert.equal(current.find(element => element.className === "job-folder").textContent, "Downloads/Summer");
  assert.equal(current.find(element => element.className === "job-count").textContent, "1 / 4 complete · 1 failed");
  assert.equal(current.find(element => element.className === "job-size").textContent, "3 KiB received",
    "A batch with unknown file sizes must not invent a total-byte denominator");
  const timestamp = current.find(element => element.className === "job-time");
  assert.match(timestamp.textContent, /^Added /);
  assert.equal(timestamp.dateTime, new Date(snapshot.jobs[1].createdAt).toISOString());
  assert.equal(get("queue-section").hidden, false);
  assert.equal(get("queue-description").textContent, "1 downloading · 1 queued");
  assert.equal(get("queue-progress").max, 4, "Queue progress excludes already archived batches");
  assert.equal(get("queue-progress").value, 2, "Finished progress includes the failed file without calling it completed");
  const files = current.filter(element => element.className === "task-row");
  assert.equal(descendants(files[0]).find(element => element.className === "task-title").textContent, "photo.jpg");
  assert.equal(descendants(files[0]).find(element => element.className === "task-size").textContent, "2 KiB");
  const unknownProgress = descendants(files[1]).find(element => element.className === "task-progress");
  assert.equal(unknownProgress.valueWrites, 0, "Unknown byte totals keep native progress indeterminate");
  const unknownSize = descendants(files[2]).find(element => element.className === "task-size");
  assert.equal(unknownSize.textContent, "—");
  assert.equal(unknownSize.title, "Size unknown");
  assert.equal(descendants(files[3]).find(element => element.className === "task-meta").textContent, "Server returned 404");
  assert.equal(descendants(rows[1]).some(element => element.tagName === "BUTTON"), false,
    "A cleared batch summary must not offer file or queue actions");
  assert.equal(descendants(rows[1]).some(element => element.className === "job-size"), false,
    "Archived summaries without byte data must not display fabricated zero sizes");
  source.focus();
  snapshot.jobs[1].tasks[1].bytesReceived += 1;
  await get("refresh-button").dispatch("click");
  assert.equal(page.document.activeElement.dataset.focusKey, "job:current:source",
    "Polling preserves focus on the recreated source link");
  snapshot.jobs[1].source = "javascript:alert(1)";
  await get("refresh-button").dispatch("click");
  const unsafeSource = descendants(get("job-list")).find(element => element.className === "job-source");
  assert.equal(unsafeSource.tagName, "SPAN", "Only HTTP(S) source pages may become navigation links");
}

async function exerciseConditionalActionsAndFilterRecovery() {
  const snapshot = emptySnapshot({
    summary: { total: 1, active: 1 },
    jobs: [{ id: "one", label: "Photo", status: "active", counts: { total: 1, active: 1, pending: 1 },
      tasks: [{ id: "file", filename: "photo.jpg", status: "in_progress", totalBytes: 4096, bytesReceived: 1024 }] }]
  });
  const page = await loadHistoryPage({ snapshot, downloads: {} });
  const get = id => page.document.getElementById(id);
  assert.equal(get("history-search").hidden, true, "A single-file queue does not need a search field");
  assert.equal(get("history-status").hidden, true, "A single-status queue does not need a status selector");
  const pause = get("pause-all-button");
  pause.focus();
  snapshot.summary.active = 0;
  snapshot.summary.paused = 1;
  Object.assign(snapshot.jobs[0].counts, { active: 0, paused: 1 });
  snapshot.jobs[0].tasks[0].status = "paused";
  await pause.dispatch("click");
  assert.equal(pause.hidden, true);
  assert.equal(page.document.activeElement, get("resume-all-button"),
    "Pausing the queue transfers keyboard focus to its newly relevant Resume action");
  Object.assign(snapshot.summary, { paused: 0, complete: 1 });
  Object.assign(snapshot.jobs[0].counts, { paused: 0, pending: 0, complete: 1 });
  snapshot.jobs[0].status = "complete";
  snapshot.jobs[0].tasks[0].status = "complete";
  await get("refresh-button").dispatch("click");
  assert.equal(get("queue-section").hidden, true);
  const clear = get("clear-completed-button");
  clear.focus();
  snapshot.jobs[0].historyOnly = true;
  snapshot.jobs[0].tasks = [];
  await clear.dispatch("click");
  assert.equal(clear.hidden, true);
  assert.equal(page.document.activeElement, get("refresh-button"),
    "Clearing the last detailed batch restores focus to an available control");
  const search = get("search-input");
  search.value = "missing";
  await search.dispatch("input");
  assert.equal(get("history-empty-title").textContent, "No matching downloads");
  assert.equal(get("reset-filters-button").hidden, false);
  await get("reset-filters-button").dispatch("click");
  assert.equal(search.value, "");
  assert.equal(get("status-filter").value, "all");
  assert.equal(get("history-empty").hidden, true);
  assert.equal(page.document.activeElement, get("refresh-button"));
}

Promise.resolve()
  .then(exerciseCompactEmptyAndStatistics)
  .then(exerciseUsefulBatchRowsAndIndeterminateSizes)
  .then(exerciseConditionalActionsAndFilterRecovery)
  .then(exercisePrivateContextAndStats)
  .then(exerciseWindowContextFallback)
  .then(exerciseRetryControls)
  .then(exerciseUnchangedRefreshSkipsDomRebuild)
  .then(exerciseDownloadsApiFailures)
  .then(exerciseFileFiltersAndLiveFocus)
  .then(() => {
    console.log("All download dashboard page checks passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
