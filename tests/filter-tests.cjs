"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Filters = require("../extension/shared/filters.js");

const filterSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/shared/filters.js"),
  "utf8"
);
const browserContext = {};
vm.createContext(browserContext);
vm.runInContext(filterSource, browserContext);
assert.equal(
  typeof browserContext.ImageDownloaderFilters.matchesSmartFilters,
  "function",
  "The browser build must expose ImageDownloaderFilters"
);

assert.deepEqual(Object.keys(Filters).sort(), [
  "DEFAULT_FILTERS",
  "hasActiveSmartFilters",
  "imageFileType",
  "isLikelyPhoto",
  "matchesSmartFilters",
  "normalizeFilters"
].sort());
assert.ok(Object.isFrozen(Filters.DEFAULT_FILTERS));
assert.deepEqual(Filters.normalizeFilters(), Filters.DEFAULT_FILTERS);

assert.deepEqual(Filters.normalizeFilters({
  mediaType: "VIDEO",
  photosOnly: "yes",
  minWidth: "299.6",
  minHeight: -12,
  format: "JPG",
  orientation: "PORTRAIT",
  includeUnknown: "off"
}), {
  mediaType: "video",
  photosOnly: true,
  format: "jpeg",
  minWidth: 300,
  minHeight: 0,
  orientation: "portrait"
});
assert.deepEqual(Filters.normalizeFilters({
  mediaType: "audio",
  minWidth: Infinity,
  minHeight: "99999999",
  format: "executable",
  orientation: "diagonal",
  photosOnly: "maybe",
  includeUnknown: null
}), {
  mediaType: "any",
  photosOnly: false,
  format: "any",
  minWidth: 0,
  minHeight: 1000000,
  orientation: "any"
});

const hostileFilters = {};
for (const filter of ["minWidth", "minHeight", "orientation", "includeUnknown"]) {
  Object.defineProperty(hostileFilters, filter, {
    get() {
      throw new Error(`Unsafe ${filter} getter`);
    }
  });
}
assert.doesNotThrow(() => Filters.normalizeFilters(hostileFilters));
assert.deepEqual(Filters.normalizeFilters(hostileFilters), Filters.DEFAULT_FILTERS);
assert.doesNotThrow(() => Filters.normalizeFilters({ minWidth: Symbol("unsafe") }));
assert.deepEqual(
  Filters.normalizeFilters({
    minWidth: Symbol("unsafe"),
    minHeight: { valueOf() { throw new Error("unsafe coercion"); } },
    orientation: "portrait",
    includeUnknown: false
  }),
  { ...Filters.DEFAULT_FILTERS, orientation: "portrait" },
  "Unsafe dimension values must fall back to zero without affecting safe filters"
);

assert.equal(Filters.imageFileType({ url: "https://cdn.test/photo.JPG?size=large" }), "jpeg");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/render?id=2&format=webp" }), "webp");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/render?fm=avif" }), "avif");
assert.equal(Filters.imageFileType({ url: "data:image/svg+xml,%3Csvg%3E" }), "svg");
assert.equal(Filters.imageFileType({ url: "data:image/png;base64,AA==" }), "png");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/no-extension", mimeType: "image/jpeg; charset=binary" }), "jpeg");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/animation.apng" }), "png");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/trailer.MP4?token=abc" }), "mp4");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/clip.mov" }), "mov");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/no-extension", mimeType: "video/webm" }), "webm");
assert.equal(Filters.imageFileType({ url: "data:video/ogg;base64,AA==" }), "ogv");
assert.equal(Filters.imageFileType({ url: "https://cdn.test/file.bmp" }), "unknown");
assert.equal(Filters.imageFileType(null), "unknown");
const mutableType = { url: "https://cdn.test/photo.jpg" };
assert.equal(Filters.imageFileType(mutableType), "jpeg");
mutableType.url = "https://cdn.test/photo.webp";
assert.equal(
  Filters.imageFileType(mutableType),
  "webp",
  "Cached file types must invalidate when media metadata changes"
);

const mutableNormalizedFilters = Filters.normalizeFilters({ format: "webp" });
assert.equal(Filters.normalizeFilters(mutableNormalizedFilters).format, "webp");
mutableNormalizedFilters.format = "PNG";
assert.equal(
  Filters.normalizeFilters(mutableNormalizedFilters).format,
  "png",
  "Normalized-filter caching must not retain a stale mutated value"
);
Object.assign(mutableNormalizedFilters, { minWidth: "640", minHeight: 480, orientation: "PORTRAIT" });
assert.deepEqual(Filters.normalizeFilters(mutableNormalizedFilters), {
  ...Filters.DEFAULT_FILTERS, format: "png", minWidth: 640, minHeight: 480, orientation: "portrait"
}, "Cached normalized filters must follow dimension and orientation edits");

const normalPhoto = {
  url: "https://gallery.test/holidays/sunset-001.webp",
  alt: "Sunset over a lake",
  width: 1920,
  height: 1080
};
assert.equal(Filters.isLikelyPhoto(normalPhoto), true);
for (const url of [
  "https://site.test/assets/company-logo.png",
  "https://site.test/icons/menu.png",
  "https://site.test/avatar/user-42.jpg",
  "https://site.test/sprites/ui.webp",
  "https://site.test/emoji/smile.png",
  "https://metrics.test/tracking/pixel.gif",
  "https://site.test/transparent_spacer.png",
  "https://site.test/favicon.ico"
]) {
  assert.equal(
    Filters.isLikelyPhoto({ url, width: 1200, height: 800 }),
    false,
    `${url} should not be treated as a photo`
  );
}
assert.equal(Filters.isLikelyPhoto({
  url: "https://site.test/assets/brand.png",
  alt: "Company logo",
  width: 1200,
  height: 800
}), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/art.svg", width: 1200, height: 800 }), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/tiny.jpg", width: 120, height: 100 }), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/strip.jpg", width: 1600, height: 50 }), false);
assert.equal(Filters.isLikelyPhoto({ url: "https://site.test/photo.jpg", width: 400, height: 300 }), true);
assert.equal(Filters.isLikelyPhoto({
  url: "https://site.test/feature.mp4",
  mediaType: "video",
  width: 1920,
  height: 1080
}), false, "Videos must not pass the Photos only heuristic");
assert.equal(
  Filters.isLikelyPhoto({ url: "https://site.test/photo-with-unknown-size.jpg", width: 0, height: 0 }),
  true,
  "Unknown dimensions should not make a safe image fail the photo heuristic"
);

assert.equal(Filters.matchesSmartFilters(normalPhoto, {}), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { format: "webp" }), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { format: "jpeg" }), false);

const unknownSize = { url: "https://gallery.test/full/photo-2.jpg", width: 0, height: 0 };
assert.equal(Filters.matchesSmartFilters(unknownSize, { includeUnknown: false }), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, {
  minWidth: 999999,
  minHeight: 999999,
  orientation: "portrait",
  includeUnknown: false
}), false, "Dimension and orientation filters must reject non-matching media");
assert.equal(Filters.matchesSmartFilters(normalPhoto, { minWidth: 1920, minHeight: 1080 }), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { minWidth: 1921 }), false);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { minHeight: 1081 }), false);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { orientation: "landscape" }), true);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { orientation: "square" }), false);
assert.equal(Filters.matchesSmartFilters({ ...normalPhoto, width: 600, height: 800 }, { orientation: "portrait" }), true);
assert.equal(Filters.matchesSmartFilters({ ...normalPhoto, width: 800, height: 800 }, { orientation: "square" }), true);
assert.equal(Filters.matchesSmartFilters(unknownSize, {}), true);
assert.equal(Filters.matchesSmartFilters(unknownSize, { minWidth: 1 }), false);
assert.equal(Filters.matchesSmartFilters(unknownSize, { minHeight: 1 }), false);
assert.equal(Filters.matchesSmartFilters(unknownSize, { orientation: "square" }), false,
  "Unknown dimensions must not be mistaken for a square");
assert.equal(Filters.matchesSmartFilters({ ...unknownSize, width: 800 }, { minWidth: 640 }), true,
  "A known width may satisfy a width-only constraint");
assert.equal(Filters.matchesSmartFilters({ ...unknownSize, width: 800 }, { orientation: "landscape" }), false);
assert.equal(Filters.matchesSmartFilters(
  { url: "https://site.test/logo.png", width: 0, height: 0 },
  { photosOnly: true }
), false);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { photosOnly: true }), true);
const normalVideo = {
  url: "https://gallery.test/clips/feature.mp4",
  mediaType: "video",
  mimeType: "video/mp4",
  width: 1920,
  height: 1080
};
assert.equal(Filters.matchesSmartFilters(normalVideo, { mediaType: "video" }), true);
assert.equal(Filters.matchesSmartFilters(normalVideo, { mediaType: "image" }), false);
assert.equal(Filters.matchesSmartFilters(normalPhoto, { mediaType: "video" }), false);
assert.equal(Filters.matchesSmartFilters(normalVideo, { format: "mp4" }), true);
assert.equal(Filters.matchesSmartFilters(normalVideo, { format: "webm" }), false);
assert.equal(Filters.matchesSmartFilters(normalVideo, { photosOnly: true }), false);
assert.equal(Filters.matchesSmartFilters(null, {}), false);

assert.equal(Filters.hasActiveSmartFilters(), false);
assert.equal(Filters.hasActiveSmartFilters({}), false);
assert.equal(Filters.hasActiveSmartFilters({ mediaType: "video" }), true);
assert.equal(Filters.hasActiveSmartFilters({ photosOnly: true }), true);
assert.equal(Filters.hasActiveSmartFilters({ format: "png" }), true);
assert.equal(Filters.hasActiveSmartFilters({
  minWidth: 1,
  minHeight: 1,
  orientation: "square",
  includeUnknown: false
}), true);
assert.equal(Filters.hasActiveSmartFilters({ minWidth: 1 }), true);
assert.equal(Filters.hasActiveSmartFilters({ minHeight: 1 }), true);
assert.equal(Filters.hasActiveSmartFilters({ orientation: "portrait" }), true);
assert.equal(Filters.hasActiveSmartFilters({ format: "invalid", minWidth: -5 }), false);

console.log("All smart-filter checks passed.");
