"use strict";

const assert = require("assert").strict;
const fs = require("node:fs");
const path = require("node:path");
const Tracking = require("../extension/tracking/tracking.js");

const trackers = [
  {
    id: "tracker-active",
    enabled: true,
    pageTitle: "Summer gallery",
    url: "https://example.test/gallery",
    folder: "Tracked/example",
    query: "portrait",
    filters: { mediaType: "image", photosOnly: true, format: "jpeg" },
    lastQueued: 3,
    lastError: ""
  },
  {
    id: "tracker-paused",
    enabled: false,
    pageTitle: "Video feed",
    url: "https://video.test/feed",
    folder: "Tracked/video",
    query: "",
    filters: { mediaType: "video", photosOnly: false, format: "mp4" },
    lastQueued: 0,
    lastError: ""
  },
  {
    id: "tracker-issue",
    enabled: true,
    pageTitle: "Restricted page",
    url: "https://private.test/photos",
    folder: "Tracked/private",
    query: "",
    filters: { mediaType: "any", photosOnly: false, format: "any" },
    lastQueued: 1,
    lastError: "The tracked page returned HTTP 403."
  }
];

assert.deepEqual(Tracking.summarizeTrackers(trackers), {
  total: 3,
  active: 2,
  paused: 1,
  issues: 1,
  queued: 4,
  reviewed: 0,
  discovered: 0,
  pending: 0
});
assert.equal(Tracking.summarizeTrackers(trackers, [{ id: "review-1" }]).pending, 1);
assert.equal(Tracking.intervalLabel(15), "Every 15 minutes");
assert.equal(Tracking.intervalLabel(60), "Every 1 hour");
assert.equal(Tracking.intervalLabel(360), "Every 6 hours");
assert.equal(Tracking.intervalLabel(1440), "Every 1 day");
assert.equal(Tracking.intervalLabel(2880), "Every 2 days");
assert.equal(
  Tracking.describeFilters(trackers[0]),
  "Images · Photos only · JPEG · Search: “portrait”"
);
assert.equal(Tracking.describeFilters(trackers[1]), "Videos · MP4");
assert.equal(Tracking.describeFilters(trackers[2]), "Images & videos");
assert.equal(Tracking.describeFilters({ filters: { minWidth: 1200, minHeight: 800, orientation: "landscape" } }), "Images & videos · At least 1200 × 800 px · Landscape");
assert.equal(Tracking.describeAction({ action: "download" }), "Download automatically");
assert.equal(Tracking.describeAction({ action: "review" }), "Add to review");
assert.equal(Tracking.describeAction({ action: "notify" }), "Notify only");
assert.equal(Tracking.describePagination(trackers[0]), "First page only");
assert.equal(
  Tracking.describePagination({ pagination: { mode: "next-link", maxPages: 5 } }),
  "Static Next link · up to 5 pages"
);
assert.equal(
  Tracking.describeMatching({
    ...trackers[0],
    matching: {
      excludeText: "thumb",
      includePatterns: ["*.jpg"],
      excludePatterns: ["*/small/*", "*/avatar/*"],
      maxDownloadsPerRun: 25
    }
  }),
  "Images · Photos only · JPEG · Search: “portrait” · Excludes “thumb” · 1 include pattern · 2 exclude patterns · Max 25/check"
);
assert.equal(Tracking.formatDuration(450), "450ms");
assert.equal(Tracking.formatDuration(1250), "1.3s");
assert.equal(Tracking.formatDuration(62000), "1m 2s");
assert.equal(Tracking.activityStatusLabel("baseline"), "Baseline");
assert.equal(Tracking.activityStatusLabel("error"), "Failed");
assert.equal(Tracking.trackerStatus(trackers[0]), "active");
assert.equal(Tracking.trackerStatus(trackers[1]), "paused");
assert.equal(Tracking.trackerStatus(trackers[2]), "issue");
assert.equal(Tracking.trackerMatchesFilter(trackers[0], "active"), true);
assert.equal(Tracking.trackerMatchesFilter(trackers[1], "active"), false);
assert.equal(Tracking.trackerMatchesFilter(trackers[1], "paused"), true);
assert.equal(Tracking.trackerMatchesFilter(trackers[2], "issues"), true);
assert.equal(Tracking.trackerMatchesSearch(trackers[0], "summer"), true);
assert.equal(Tracking.trackerMatchesSearch(trackers[0], "tracked/example"), true);
assert.equal(Tracking.trackerMatchesSearch(trackers[0], "PORTRAIT"), true);
assert.equal(Tracking.trackerMatchesSearch(trackers[0], "video"), false);
assert.equal(Tracking.trackerMatchesSearch(trackers[2], "403"), true);
assert.equal(Tracking.nextCheckAt({ enabled: false, nextRunAt: 123, backoffUntil: 456 }), 0,
  "Paused trackers must not claim a scheduled next check");
assert.equal(Tracking.nextCheckAt({ enabled: true, nextRunAt: 123, backoffUntil: 456 }), 456,
  "Retry backoff must take precedence over an earlier regular check");
assert.equal(Tracking.describeLastResult({ lastSuccessAt: 1, lastFound: 28, lastQueued: 0 }), "No new media",
  "Successful checks without new media should not fill the row with zero counts");
assert.equal(Tracking.describeLastResult({ activity: [{ status: "baseline", found: 12 }] }), "Baseline recorded · no action");
assert.equal(Tracking.describeLastResult({ action: "review", activity: [{ status: "success", reviewed: 3 }] }), "3 added to review");
assert.equal(Tracking.describeLastResult({ action: "notify", activity: [{ status: "success", discovered: 2 }] }), "2 new",
  "Notification attempts must not be presented as confirmed notification deliveries");
assert.equal(Tracking.describeLastResult({ lastError: "Queue full", activity: [{ status: "partial", queued: 2 }] }), "Partial · 2 queued",
  "Partial failures must retain the files already queued");
assert.equal(Tracking.describeLastResult({ action: "review", activity: [{ status: "success", queued: 4 }] }), "4 queued",
  "Changing tracker mode must not rewrite the outcome of a completed check");

class Element {
  constructor(document, tagName = "div", id = "") {
    Object.assign(this, { document, tagName, id, children: [], listeners: {}, attributes: {}, value: "", className: "" });
  }
  append(...children) {
    this.children.push(...children);
    for (const child of children) child.parentElement = this;
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  closest(selector) {
    return selector.split(", ").some((name) => this.className.split(" ").includes(name.slice(1)))
      ? this : this.parentElement?.closest(selector) || null;
  }
  async dispatch(name) {
    if (!this.disabled) await this.listeners[name]?.({ target: this });
  }
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

async function loadDashboard({ incognito = false, failures = new Set(), changeTrackersDuringReview = false, workspace,
  initialTrackers = trackers, initialReviews, loadError = false, deferLoad = false, deferContext = false,
  sourceTabId = "", createError = false } = {}) {
  const document = { activeElement: null, listeners: {} };
  const html = fs.readFileSync(path.join(__dirname, "../extension/tracking/tracking.html"), "utf8");
  const elements = new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map((match) =>
    [match[2], new Element(document, match[1], match[2])]
  ));
  elements.get("status-filter").value = "all";
  elements.get("review-tracker-filter").value = "all";
  document.createElement = (name) => new Element(document, name);
  document.getElementById = (id) => elements.get(id) || [...elements.values()].flatMap(descendants).find((node) => node.id === id);
  document.addEventListener = (name, listener) => { document.listeners[name] = listener; };
  const messages = [];
  const openedTabs = [];
  const openedWindows = [];
  let loadResolver;
  let contextResolver;
  let storedTrackers = structuredClone(initialTrackers);
  let storedReviews = structuredClone(initialReviews || [
    { id: "review-one", trackerId: "tracker-active", filename: "one.jpg", url: "https://example.test/one.jpg", mediaType: "image" },
    { id: "review-two", trackerId: "tracker-paused", filename: "two.mp4", url: "https://video.test/two.mp4", mediaType: "video" },
    { id: "review-three", trackerId: "tracker-active", filename: "three.jpg", url: "https://example.test/three.jpg", mediaType: "image" }
  ]);
  let storageListener;
  Tracking.initialize({
    document,
    location: { href: `moz-extension://test/tracking/tracking.html?sourceTabId=${encodeURIComponent(sourceTabId)}` },
    frameElement: workspace ? {} : null,
    parent: { AnyDownloadWorkspace: workspace },
    confirm: () => true,
    browser: {
      tabs: {
        getCurrent: async () => deferContext ? new Promise(resolve => { contextResolver = resolve; }) : { incognito },
        create: async (value) => {
          if (createError) throw new Error("Temporary page access unavailable.");
          openedTabs.push(value);
        }
      },
      windows: { create: async (value) => openedWindows.push(value) },
      storage: { onChanged: { addListener: (listener) => { storageListener = listener; } } },
      runtime: {
        getURL: (value) => `moz-extension://test/${value}`,
        sendMessage: async (message) => {
          messages.push(message);
          if (message.type === "GET_TRACKERS") {
            if (loadError) throw new Error("Tracker storage unavailable.");
            if (deferLoad) await new Promise(resolve => { loadResolver = resolve; });
            return { ok: true, trackers: structuredClone(storedTrackers), reviews: structuredClone(storedReviews) };
          }
          if (message.type === "TRACKER_REVIEW_ACTION") {
            if (changeTrackersDuringReview) {
              storedTrackers[0].lastError = "Page check failed during review.";
              storageListener({ "mediaTrackers:v1": {} }, "local");
            }
            if (failures.has(message.id)) return { ok: false, error: "Download queue is full." };
            storedReviews = storedReviews.filter((item) => item.id !== message.id);
            return { ok: true, reviews: structuredClone(storedReviews), queued: message.action === "approve" ? 1 : 0 };
          }
          if (message.type === "SET_TRACKER_ENABLED") {
            storedTrackers = storedTrackers.map((tracker) => tracker.id === message.id ? { ...tracker, enabled: message.enabled } : tracker);
            return { ok: true, tracker: structuredClone(storedTrackers.find((tracker) => tracker.id === message.id)) };
          }
          if (message.type === "SET_ALL_TRACKERS_ENABLED") {
            storedTrackers = storedTrackers.map((tracker) => ({ ...tracker, enabled: message.enabled }));
            return { ok: true, trackers: structuredClone(storedTrackers) };
          }
          throw new Error(`Unexpected message: ${message.type}`);
        }
      }
    }
  });
  const initialized = document.listeners.DOMContentLoaded();
  if (!deferContext) await initialized;
  await new Promise(setImmediate);
  return { document, elements, messages, openedTabs, openedWindows, storageListener,
    async finishLoading() { deferLoad = false; loadResolver(); await new Promise(setImmediate); },
    async finishContext() { contextResolver({ incognito }); await initialized; await new Promise(setImmediate); },
    recoverLoading() { loadError = false; },
    async updateReviews(values) {
      storedReviews = structuredClone(values);
      storageListener({ "trackerReviewItems:v1": {} }, "local");
      await new Promise(setImmediate);
    }
  };
}

async function testDashboardActions() {
  const failures = new Set(["review-three"]);
  const page = await loadDashboard({ failures });
  const get = (id) => page.document.getElementById(id);
  assert.equal(get("review-list").children.length, 3);
  assert.ok(descendants(get("review-list")).some((node) => node.textContent === "Destination: Downloads/Tracked/example"));
  assert.equal(get("review-review-one-download").textContent, "Download");
  get("review-review-two-select").checked = true;
  get("review-review-two-select").focus();
  await get("review-review-two-select").dispatch("change");
  assert.equal(page.document.activeElement, get("review-review-two-select"), "Selection rerenders retain the focused checkbox");
  get("review-tracker-filter").value = "tracker-active";
  await get("review-tracker-filter").dispatch("change");
  assert.equal(get("review-list").children.length, 2);
  assert.match(get("review-status").textContent, /1 selected \(1 hidden/);
  get("review-select-all").checked = true;
  await get("review-select-all").dispatch("change");
  assert.match(get("review-status").textContent, /3 selected/);
  await get("download-selected-button").dispatch("click");
  assert.deepEqual(page.messages.filter((message) => message.type === "TRACKER_REVIEW_ACTION").map((message) => message.id), ["review-one", "review-two", "review-three"]);
  assert.equal(get("review-list").children.length, 1, "A failed bulk item stays in review");
  assert.equal(get("review-review-three-select").checked, true, "A failed bulk item stays selected for retry");
  assert.match(get("review-status").textContent, /2 added to Downloads/);
  assert.match(get("error-banner").textContent, /queue is full/);
  failures.clear();
  await get("dismiss-selected-button").dispatch("click");
  assert.equal(get("review-list").children.length, 0);
  assert.equal(get("review-section").hidden, true, "Empty review inboxes should not occupy the manager");
  assert.match(get("review-status").textContent, /1 item dismissed/);
  assert.equal(get("download-selected-button").disabled, true);

  const toggleId = "tracker-tracker-active-toggle";
  get(toggleId).focus();
  await get(toggleId).dispatch("click");
  assert.equal(get(toggleId).textContent, "Resume");
  assert.equal(page.document.activeElement, get(toggleId), "A tracker action restores the same control after its busy state");
  page.storageListener({ "mediaTrackers:v1": {} }, "local");
  await new Promise(setImmediate);
  assert.equal(page.document.activeElement, get(toggleId), "Storage refresh retains keyboard focus");
  await get("tracker-tracker-active-details-toggle").dispatch("click");
  await get("tracker-tracker-active-edit").dispatch("click");
  assert.equal(page.openedTabs[0].url, "moz-extension://test/popup/popup.html?editTrackerId=tracker-active");

  const editedTrackerIds = [];
  const embedded = await loadDashboard({ workspace: { editTracker: async (id) => editedTrackerIds.push(id) } });
  await embedded.document.getElementById("tracker-tracker-active-details-toggle").dispatch("click");
  await embedded.document.getElementById("tracker-tracker-active-edit").dispatch("click");
  assert.deepEqual(editedTrackerIds, ["tracker-active"], "Embedded tracker edits use the parent workspace");
  assert.equal(embedded.openedTabs.length, 0, "Embedded editing must not open a separate tab");

  const individual = await loadDashboard();
  const dismiss = individual.document.getElementById("review-review-one-dismiss");
  dismiss.focus();
  await dismiss.dispatch("click");
  assert.equal(individual.document.activeElement, individual.elements.get("review-heading"), "Removing the focused review moves focus to the inbox heading");
  assert.equal(individual.elements.get("review-list").children.length, 2);

  const privatePage = await loadDashboard({ incognito: true });
  assert.equal(privatePage.messages.length, 0, "Private dashboards never read persistent trackers");
  assert.equal(privatePage.elements.get("download-selected-button").disabled, true);
  assert.equal(privatePage.elements.get("review-tracker-filter").disabled, true);
  assert.equal(privatePage.elements.get("review-section").hidden, true);
  assert.equal(privatePage.elements.get("empty-title").textContent, "Trackers are unavailable in private windows.");
}

async function testStorageRefreshDuringBulkReview() {
  const page = await loadDashboard({ failures: new Set(["review-three"]), changeTrackersDuringReview: true });
  const get = (id) => page.document.getElementById(id);
  get("review-select-all").checked = true;
  await get("review-select-all").dispatch("change");
  await get("download-selected-button").dispatch("click");
  assert.equal(page.messages.filter((message) => message.type === "GET_TRACKERS").length, 2,
    "Changes during busy review must coalesce into one refresh when the action finishes");
  assert.equal(page.messages.at(-1).type, "GET_TRACKERS", "Refresh must wait until all review responses settle");
  assert.match(get("tracker-summary").textContent, /2 issues/, "A tracker finishing during review must not leave stale status");
  assert.match(get("tracker-tracker-active").className, /has-error/);
  assert.match(get("error-banner").textContent, /queue is full/, "Background refresh must preserve partial-failure feedback");
  assert.equal(get("review-review-three-select").checked, true, "Refresh must preserve the failed item's selection");
}

async function testCompactManagerDataAndDetails() {
  const now = Date.now();
  const completedAt = now - 60 * 60000;
  const historical = { status: "success", startedAt: completedAt - 1200, finishedAt: completedAt,
    found: 12, queued: 4, reviewed: 0, discovered: 4, pagesChecked: 1, durationMs: 1200 };
  const page = await loadDashboard({ initialReviews: [], initialTrackers: [{
    id: "scheduled", enabled: true, action: "review", pageTitle: "Photos", url: "https://photos.example/album",
    nextRunAt: now + 60000, backoffUntil: now + 120000, intervalMinutes: 60, folder: "Photos",
    lastRunAt: now - 1000, lastSuccessAt: completedAt, activity: [historical]
  }, {
    id: "paused", enabled: false, action: "notify", pageTitle: "Videos", url: "https://video.example/feed",
    nextRunAt: now + 60000, backoffUntil: now + 120000, lastSuccessAt: completedAt,
    lastFound: 19, lastDiscovered: 0
  }, {
    id: "failed", enabled: false, autoPausedReason: "Repeated failures", lastError: "HTTP 403",
    pageTitle: "Restricted page", url: "https://restricted.example", activity: []
  }] });
  const get = (id) => page.document.getElementById(id);
  assert.equal(get("tracker-summary").textContent, "1 active · 2 paused · 1 issue");
  assert.equal(get("review-section").hidden, true);
  assert.equal(get("review-link").hidden, true);
  assert.equal(get("header-create-tracker-button").hidden, false, "Populated managers need an Add tracker action for another page");
  assert.ok(descendants(get("tracker-scheduled")).some((node) => node.className === "tracker-domain" && node.textContent === "photos.example"));
  assert.equal(get("tracker-scheduled-next-check").children[1].textContent,
    new Date(now + 120000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    "Rows must show the effective retry schedule");
  assert.equal(get("tracker-scheduled-last-check").children[1].textContent,
    new Date(completedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    "A newly started run must not redate the previous completed result");
  assert.equal(get("tracker-paused-next-check").children[1].textContent, "Paused");
  assert.equal(get("tracker-failed-last-check").children[1].textContent, "—");
  assert.equal(get("tracker-failed-last-check").children.length, 2, "The failure shown below the row must not be repeated in Last check");
  assert.ok(descendants(get("tracker-failed")).some((node) => node.className.startsWith("status-pill") && node.textContent === "Automatically paused · issue"));
  assert.ok(descendants(get("tracker-paused-last-check")).some((node) => node.textContent === "No new media"));
  assert.equal(get("tracker-scheduled-details").hidden, true);
  const detailsButton = get("tracker-scheduled-details-toggle");
  detailsButton.focus();
  await detailsButton.dispatch("click");
  assert.equal(get("tracker-scheduled-details").hidden, false);
  assert.equal(get("tracker-scheduled-details-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(page.document.activeElement, get("tracker-scheduled-details-toggle"));
  await get("tracker-scheduled-activity").dispatch("click");
  assert.ok(descendants(get("tracker-scheduled-activity-list")).some((node) => /4 queued/.test(node.textContent)),
    "Activity must retain its original download outcome after changing mode to Review");
  page.storageListener({ "mediaTrackers:v1": {} }, "local");
  await new Promise(setImmediate);
  assert.equal(get("tracker-scheduled-details").hidden, false, "Refresh must preserve disclosure state");
}

async function testEmptyAndLoadFailureStates() {
  const empty = await loadDashboard({ initialTrackers: [], initialReviews: [] });
  assert.equal(empty.elements.get("tracker-tools").hidden, true);
  assert.equal(empty.elements.get("review-section").hidden, true);
  assert.equal(empty.elements.get("tracker-summary").hidden, true);
  assert.equal(empty.elements.get("empty-title").textContent, "Check a page for new media");
  assert.match(empty.elements.get("empty-detail").textContent, /schedule for new images or videos/);
  assert.equal(empty.elements.get("create-tracker-button").hidden, false);
  assert.equal(empty.elements.get("empty-setup").hidden, false);
  assert.equal(empty.elements.get("header-create-tracker-button").hidden, true, "First use should have one clear Add tracker action");
  const failed = await loadDashboard({ loadError: true });
  assert.equal(failed.elements.get("empty-title").textContent, "Could not load trackers");
  assert.equal(failed.elements.get("refresh-button").disabled, false);
  assert.equal(failed.elements.get("review-section").hidden, true);
  assert.equal(failed.elements.get("tracker-summary").hidden, true);
  assert.equal(failed.elements.get("retry-trackers-button").hidden, false);
  assert.equal(failed.elements.get("create-tracker-button").hidden, true, "Unknown saved state must not be presented as a first-use empty inbox");
  failed.recoverLoading();
  await failed.elements.get("retry-trackers-button").dispatch("click");
  assert.equal(failed.elements.get("retry-trackers-button").hidden, true);
  assert.equal(failed.elements.get("tracker-list").hidden, false, "Retry must load saved tracker rows");
}

async function testUsefulTrackerStateActions() {
  const empty = await loadDashboard({ initialTrackers: [], initialReviews: [], sourceTabId: "42" });
  await empty.elements.get("create-tracker-button").dispatch("click");
  assert.deepEqual(empty.openedTabs, [{ active: true, url: "moz-extension://test/popup/popup.html?createTracker=1&sourceTabId=42" }],
    "Add tracker must open the real setup route and preserve a valid source page");
  const untrustedSource = await loadDashboard({ initialTrackers: [], initialReviews: [], sourceTabId: "42&incognito=true" });
  await untrustedSource.elements.get("create-tracker-button").dispatch("click");
  assert.equal(untrustedSource.openedTabs[0].url, "moz-extension://test/popup/popup.html?createTracker=1",
    "Setup navigation must ignore malformed source IDs and unrelated parameters");
  let openedSetup = 0;
  const embedded = await loadDashboard({ initialTrackers: [], initialReviews: [], workspace: { createTracker() { openedSetup += 1; } } });
  await embedded.elements.get("create-tracker-button").dispatch("click");
  assert.equal(openedSetup, 1);
  assert.equal(embedded.openedTabs.length, 0, "Embedded Add tracker must use the current manager's setup flow");
  const unavailable = await loadDashboard({ initialTrackers: [], initialReviews: [], createError: true });
  await unavailable.elements.get("create-tracker-button").dispatch("click");
  assert.equal(unavailable.elements.get("create-tracker-button").disabled, false);
  assert.match(unavailable.elements.get("error-banner").textContent, /Could not open tracker setup/);

  const filtered = await loadDashboard({ initialReviews: [] });
  filtered.elements.get("search-input").value = "no-matching-page";
  await filtered.elements.get("search-input").dispatch("input");
  assert.equal(filtered.elements.get("empty-state").getAttribute("data-state"), "filtered");
  assert.equal(filtered.elements.get("reset-filters-button").hidden, false);
  assert.equal(filtered.elements.get("empty-setup").hidden, true);
  filtered.elements.get("reset-filters-button").focus();
  await filtered.elements.get("reset-filters-button").dispatch("click");
  assert.equal(filtered.elements.get("tracker-list").hidden, false);
  assert.equal(filtered.elements.get("search-input").value, "");
  assert.equal(filtered.document.activeElement, filtered.elements.get("search-input"));

  const loading = await loadDashboard({ initialTrackers: [], initialReviews: [], deferLoad: true });
  assert.equal(loading.elements.get("empty-state").getAttribute("data-state"), "loading");
  assert.equal(loading.elements.get("empty-actions").hidden, true);
  assert.equal(loading.elements.get("empty-setup").hidden, true);
  assert.equal(loading.elements.get("header-create-tracker-button").hidden, true);
  await loading.finishLoading();
  assert.equal(loading.elements.get("create-tracker-button").hidden, false);

  const privatePage = await loadDashboard({ incognito: true, sourceTabId: "99", deferContext: true });
  await privatePage.elements.get("refresh-button").dispatch("click");
  await privatePage.elements.get("create-tracker-button").dispatch("click");
  assert.equal(privatePage.messages.length, 0, "Pending context detection must never read persistent trackers");
  assert.equal(privatePage.openedTabs.length, 0);
  await privatePage.finishContext();
  assert.equal(privatePage.elements.get("empty-state").getAttribute("data-state"), "private");
  assert.equal(privatePage.elements.get("create-tracker-button").hidden, true);
  assert.equal(privatePage.elements.get("empty-setup").hidden, true);
  await privatePage.elements.get("open-regular-window-button").dispatch("click");
  assert.deepEqual(privatePage.openedWindows, [{ incognito: false, url: "moz-extension://test/tracking/tracking.html" }],
    "Opening regular-window tracking must not carry a private source tab ID");
  assert.equal(privatePage.messages.length, 0);
  const html = fs.readFileSync(path.join(__dirname, "../extension/tracking/tracking.html"), "utf8");
  assert.match(html, /first check records a baseline without taking action/);
  assert.match(html, /Trackers do not run page JavaScript or replay infinite scrolling/);
}

async function testBulkActionFocus() {
  const page = await loadDashboard();
  const get = (id) => page.document.getElementById(id);
  assert.equal(get("review-link").textContent, "3 to review");
  get("pause-all-button").focus();
  await get("pause-all-button").dispatch("click");
  assert.equal(get("pause-all-button").hidden, true);
  assert.equal(page.document.activeElement, get("resume-all-button"), "Hiding Pause all must leave focus on the applicable action");
  await get("resume-all-button").dispatch("click");
  assert.equal(get("resume-all-button").hidden, true);
  assert.equal(page.document.activeElement, get("pause-all-button"));
  get("review-select-all").checked = true;
  await get("review-select-all").dispatch("change");
  get("dismiss-selected-button").focus();
  await get("dismiss-selected-button").dispatch("click");
  assert.equal(get("review-section").hidden, true);
  assert.equal(get("review-link").hidden, true);
  assert.equal(page.document.activeElement, get("tracker-heading"), "Clearing the review inbox must leave focus on a visible heading");

  const individual = await loadDashboard({ initialReviews: [{ id: "last", trackerId: "tracker-active", filename: "last.jpg", url: "https://example.test/last.jpg" }] });
  const dismiss = individual.document.getElementById("review-last-dismiss");
  dismiss.focus();
  await dismiss.dispatch("click");
  assert.equal(individual.document.activeElement, individual.elements.get("tracker-heading"));
  for (const id of ["review-select-all", "review-tracker-filter"]) {
    const external = await loadDashboard();
    external.elements.get(id).focus();
    await external.updateReviews([]);
    assert.equal(external.document.activeElement, external.elements.get("tracker-heading"),
      `Removing the inbox from another window must move focus out of hidden ${id}`);
  }
}

testDashboardActions().then(testStorageRefreshDuringBulkReview).then(testCompactManagerDataAndDetails)
  .then(testEmptyAndLoadFailureStates).then(testUsefulTrackerStateActions).then(testBulkActionFocus)
  .then(() => console.log("Tracking dashboard model and UI tests passed.")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
