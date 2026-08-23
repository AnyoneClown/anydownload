"use strict";

const assert = require("assert").strict;
const Tracker = require("../extension/shared/tracker.js");

class NodeFixture {
  constructor(localName, attributes) {
    this.localName = localName;
    this.attributes = { ...(attributes || {}) };
  }

  getAttribute(name) {
    return this.attributes[name] == null ? null : String(this.attributes[name]);
  }
}

class DocumentFixture {
  constructor(nodes, nextNode) {
    this.nodes = nodes;
    this.nextNode = nextNode || null;
  }

  querySelectorAll() {
    return this.nodes;
  }

  querySelector() {
    return this.nextNode;
  }
}

assert.equal(
  Tracker.normalizePageUrl("https://example.test/gallery#loaded"),
  "https://example.test/gallery"
);
assert.equal(Tracker.normalizePageUrl("javascript:alert(1)"), "");
assert.equal(Tracker.normalizePageUrl("https://user:secret@example.test/gallery"), "");
assert.equal(
  Tracker.permissionPatternForUrl("https://example.test:8443/gallery"),
  "https://example.test/*"
);

const firstSignedUrl = {
  url: "https://cdn.example.test/photo.jpg?size=large&token=first&expires=100"
};
const refreshedSignedUrl = {
  url: "https://cdn.example.test/photo.jpg?expires=200&token=second&size=large"
};
assert.equal(
  Tracker.mediaFingerprint(firstSignedUrl),
  Tracker.mediaFingerprint(refreshedSignedUrl),
  "Expiring credentials must not make an existing file look new"
);
assert.notEqual(
  Tracker.mediaFingerprint(firstSignedUrl),
  Tracker.mediaFingerprint({ url: "https://cdn.example.test/other.jpg?size=large" })
);
assert.equal(Tracker.matchesQuery({ alt: "Summer coast" }, "COAST"), true);
assert.equal(Tracker.matchesQuery({ alt: "Summer coast" }, "winter"), false);
assert.equal(Tracker.wildcardMatches("https://example.test/gallery/photo-01.jpg", "*/gallery/photo-??.jpg"), true);
assert.equal(Tracker.wildcardMatches("https://example.test/thumbs/photo-01.jpg", "*/gallery/*.jpg"), false);
assert.equal(Tracker.matchesTrackerRules({
  url: "https://example.test/gallery/portrait.jpg",
  alt: "Summer portrait"
}, {
  includeText: "portrait",
  excludeText: "thumbnail",
  includePatterns: ["*/gallery/*.jpg"],
  excludePatterns: ["*/thumbs/*"]
}), true);
assert.equal(Tracker.matchesTrackerRules({
  url: "https://example.test/thumbs/portrait.jpg",
  alt: "Summer portrait thumbnail"
}, {
  includeText: "portrait",
  excludeText: "thumbnail",
  includePatterns: ["*.jpg"]
}), false);

assert.equal(
  Tracker.pageUrlFromTemplate("/gallery?page={page}", 3, "https://example.test/gallery"),
  "https://example.test/gallery?page=3"
);
assert.equal(
  Tracker.pageUrlFromTemplate("https://other.test/gallery?page={page}", 2, "https://example.test/gallery"),
  "",
  "Pagination templates must stay on the tracked origin"
);
assert.equal(
  Tracker.extractNextPageUrl(
    new DocumentFixture([], new NodeFixture("a", { href: "/gallery?page=2" })),
    "https://example.test/gallery",
    "a.next"
  ),
  "https://example.test/gallery?page=2"
);
assert.equal(
  Tracker.extractNextPageUrl(
    new DocumentFixture([], new NodeFixture("a", { href: "https://other.test/gallery?page=2" })),
    "https://example.test/gallery",
    "a.next"
  ),
  "",
  "Next-link pagination must not cross origins"
);

const nodes = [
  new NodeFixture("img", {
    "data-original": "/media/original.jpg?token=one",
    src: "/media/thumb.jpg",
    alt: "Gallery portrait",
    width: "1200",
    height: "800"
  }),
  new NodeFixture("video", {
    src: "/media/clip.mp4",
    poster: "/media/poster.jpg",
    type: "video/mp4"
  }),
  new NodeFixture("a", { href: "/assets/direct.webp" }),
  new NodeFixture("a", { href: "/ordinary-page" }),
  new NodeFixture("div", { style: "background-image: url('/assets/background.png')" })
];
const extracted = Tracker.extractMediaFromDocument(
  new DocumentFixture(nodes),
  "https://example.test/gallery/index.html"
);

assert.deepEqual(
  extracted.map((item) => item.url),
  [
    "https://example.test/media/original.jpg?token=one",
    "https://example.test/media/clip.mp4",
    "https://example.test/assets/direct.webp",
    "https://example.test/assets/background.png"
  ],
  "The first static HTML page should yield preferred direct media without thumbnail duplicates"
);
assert.equal(extracted[0].mediaType, "image");
assert.equal(extracted[0].width, 1200);
assert.equal(extracted[1].mediaType, "video");
assert.equal(extracted[1].previewUrl, "https://example.test/media/poster.jpg");
assert.ok(!extracted.some((item) => item.url.endsWith("poster.jpg")), "A video poster is not a video download");

const now = Date.UTC(2026, 7, 13, 10, 0, 0);
const normalized = Tracker.normalizeTracker({
  id: "tracker-12345678",
  url: "https://example.test/gallery#section",
  pageTitle: " Example gallery ",
  folder: "Tracked/example.test",
  intervalMinutes: 1,
  filters: { mediaType: "image", photosOnly: false, format: "jpeg" },
  query: "portrait",
  matching: {
    includeText: "portrait",
    excludeText: "thumbnail",
    includePatterns: ["*.jpg", "*.jpg", "*.webp"],
    excludePatterns: "*/thumbs/*\n*/avatars/*",
    maxDownloadsPerRun: 500
  },
  pagination: {
    mode: "url-template",
    maxPages: 99,
    urlTemplate: "/gallery?page={page}"
  },
  notifications: { newMatches: false, errors: true },
  filenameTemplate: "{index}-{filename}",
  seen: [Tracker.mediaFingerprint(firstSignedUrl), "invalid"],
  activity: Array.from({ length: Tracker.MAX_ACTIVITY + 5 }, (_value, index) => ({
    startedAt: now + index,
    finishedAt: now + index + 5,
    durationMs: 5,
    reason: index === Tracker.MAX_ACTIVITY + 4 ? "permission" : "alarm",
    status: "success",
    pagesChecked: 2,
    found: 3,
    queued: 1,
    message: `Run ${index}`
  }))
}, now);
assert.ok(normalized);
assert.equal(normalized.intervalMinutes, Tracker.MIN_INTERVAL_MINUTES);
assert.equal(normalized.url, "https://example.test/gallery");
assert.deepEqual(normalized.filters, { mediaType: "image", photosOnly: false, format: "jpeg" });
assert.equal(normalized.seen.length, 1);
assert.deepEqual(normalized.matching.includePatterns, ["*.jpg", "*.webp"]);
assert.deepEqual(normalized.matching.excludePatterns, ["*/thumbs/*", "*/avatars/*"]);
assert.equal(normalized.matching.maxDownloadsPerRun, Tracker.MAX_DOWNLOADS_PER_RUN);
assert.equal(normalized.pagination.mode, "url-template");
assert.equal(normalized.pagination.maxPages, Tracker.MAX_PAGES_PER_RUN);
assert.equal(normalized.pagination.urlTemplate, "/gallery?page={page}");
assert.deepEqual(normalized.notifications, { newMatches: false, errors: true });
assert.equal(normalized.activity.length, Tracker.MAX_ACTIVITY);
assert.equal(normalized.activity[0].message, "Run 5");
assert.equal(normalized.activity[normalized.activity.length - 1].reason, "permission");

const invalidPagination = Tracker.normalizePagination({
  mode: "url-template",
  urlTemplate: "https://other.test/gallery?page={page}"
}, "https://example.test/gallery");
assert.equal(invalidPagination.mode, "none");
assert.equal(invalidPagination.maxPages, 1);

const oldest = Array.from({ length: Tracker.MAX_SEEN }, (_value, index) =>
  index.toString(16).padStart(16, "0")
);
const newest = "ffffffffffffffff";
const recorded = Tracker.recordSeen(oldest, [newest]);
assert.equal(recorded.length, Tracker.MAX_SEEN);
assert.equal(recorded[0], newest);
assert.ok(!recorded.includes(oldest[oldest.length - 1]));

console.log("Tracker model tests passed.");
