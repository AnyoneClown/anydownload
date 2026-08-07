"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const historySource = fs.readFileSync(
  path.resolve(__dirname, "../extension/history/history.js"),
  "utf8"
);

const ELEMENT_IDS = [
  "bytes-detail",
  "bytes-stat",
  "cancel-pending-button",
  "clear-completed-button",
  "completed-detail",
  "completed-stat",
  "dashboard-subtitle",
  "error-banner",
  "history-empty",
  "job-list",
  "open-folder-button",
  "pause-all-button",
  "queue-description",
  "queue-detail",
  "queue-progress",
  "queue-stat",
  "refresh-button",
  "resume-all-button",
  "retry-failed-button",
  "status-filter",
  "success-detail",
  "success-stat"
];

class FakeElement {
  constructor(tagName, id) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.id = id || "";
    this.children = [];
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.max = 1;
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.value = id === "status-filter" ? "all" : 0;
  }

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
  }

  replaceChildren(...children) {
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
    return new FakeElement(tagName);
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
    "8 completed · 1 failed · 1 cancelled today"
  );
  assert.equal(
    page.document.getElementById("success-detail").textContent,
    "80% success today · 2 failed · 1 cancelled lifetime"
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
  assert.equal(unsupportedShow.disabled, true);
}

Promise.resolve()
  .then(exercisePrivateContextAndStats)
  .then(exerciseWindowContextFallback)
  .then(exerciseRetryControls)
  .then(exerciseDownloadsApiFailures)
  .then(() => {
    console.log("All download dashboard page checks passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
