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

async function loadDashboard({ incognito = false, failures = new Set(), changeTrackersDuringReview = false } = {}) {
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
  let storedTrackers = structuredClone(trackers);
  let storedReviews = [
    { id: "review-one", trackerId: "tracker-active", filename: "one.jpg", url: "https://example.test/one.jpg", mediaType: "image" },
    { id: "review-two", trackerId: "tracker-paused", filename: "two.mp4", url: "https://video.test/two.mp4", mediaType: "video" },
    { id: "review-three", trackerId: "tracker-active", filename: "three.jpg", url: "https://example.test/three.jpg", mediaType: "image" }
  ];
  let storageListener;
  Tracking.initialize({
    document,
    confirm: () => true,
    browser: {
      tabs: { getCurrent: async () => ({ incognito }), create: async (value) => openedTabs.push(value) },
      storage: { onChanged: { addListener: (listener) => { storageListener = listener; } } },
      runtime: {
        getURL: (value) => `moz-extension://test/${value}`,
        sendMessage: async (message) => {
          messages.push(message);
          if (message.type === "GET_TRACKERS") return { ok: true, trackers: structuredClone(storedTrackers), reviews: structuredClone(storedReviews) };
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
          throw new Error(`Unexpected message: ${message.type}`);
        }
      }
    }
  });
  await document.listeners.DOMContentLoaded();
  await new Promise(setImmediate);
  return { document, elements, messages, openedTabs, storageListener };
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
  await get("tracker-tracker-active-edit").dispatch("click");
  assert.equal(page.openedTabs[0].url, "moz-extension://test/popup/popup.html?editTrackerId=tracker-active");

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
  assert.equal(get("issues-stat").textContent, "2", "A tracker finishing during review must not leave stale status");
  assert.match(get("tracker-tracker-active").className, /has-error/);
  assert.match(get("error-banner").textContent, /queue is full/, "Background refresh must preserve partial-failure feedback");
  assert.equal(get("review-review-three-select").checked, true, "Refresh must preserve the failed item's selection");
}

testDashboardActions().then(testStorageRefreshDuringBulkReview).then(() => console.log("Tracking dashboard model and UI tests passed.")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
