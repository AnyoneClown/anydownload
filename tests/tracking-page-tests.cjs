"use strict";

const assert = require("assert").strict;
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
  queued: 4
});
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

console.log("Tracking dashboard model tests passed.");
